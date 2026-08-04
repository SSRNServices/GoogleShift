// @ts-nocheck
import { drive_v3 } from 'googleapis';
import { ManifestItem } from '../utils/ManifestStorage';
import { AdaptiveRateLimiter } from './AdaptiveRateLimiter';
import { MigrationStateManager } from '../services/MigrationStateManager';
import { getCheckpoint, saveCheckpoint } from '../utils/database';
import { PassThrough } from 'stream';
import {
  DownloadError,
  DownloadTimeoutError,
  UploadError,
  UploadTimeoutError,
  UploadStallError,
  GoogleApiError,
  classifyError
} from '../utils/errors';
import { MigrationConfig } from './types';
import { prisma } from '../utils/database';

/**
 * Minimum expected transfer speed used for adaptive timeout calculation.
 * 512 KB/s is a conservative lower bound — even on throttled connections.
 * This means a 2 GB file gets at least 2000/0.512 ≈ 65 minutes before timeout.
 */
const MIN_EXPECTED_SPEED_BYTES_PER_SEC = 512 * 1024; // 512 KB/s

/**
 * Absolute minimum file transfer timeout regardless of file size.
 * No file should have less than 10 minutes to complete.
 */
const MIN_FILE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Absolute maximum file transfer timeout cap.
 * Even a 200 GB file won't get more than 8 hours.
 */
const MAX_FILE_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours

/**
 * If no upload progress bytes are received for this long → abort as a stall.
 * This is a rolling stall watchdog, distinct from the global per-file timeout.
 */
const UPLOAD_STALL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes without any byte progress

/** How often to check upload stall status */
const UPLOAD_STALL_CHECK_INTERVAL_MS = 15_000; // 15 seconds

/**
 * Calculate adaptive transfer timeout for a given file size.
 * Formula: max(MIN_TIMEOUT, fileSize / MIN_SPEED)
 * Capped at MAX_TIMEOUT.
 */
function computeTransferTimeout(fileSizeBytes: number): number {
  const sizeBasedTimeout = (fileSizeBytes / MIN_EXPECTED_SPEED_BYTES_PER_SEC) * 1000;
  return Math.min(MAX_FILE_TIMEOUT_MS, Math.max(MIN_FILE_TIMEOUT_MS, sizeBasedTimeout));
}

export class UploadWorker {
  public id: number;
  private sourceDrive: drive_v3.Drive;
  private destDrive: drive_v3.Drive;
  private rateLimiter: AdaptiveRateLimiter;
  private stateManager: MigrationStateManager;
  private jobId: string;
  private manifestId: string;
  private options: any;
  private folderCache: Map<string, string>;
  private config: MigrationConfig;

  public affinity: string = 'MEDIUM';
  public isBusy: boolean = false;
  public isDead: boolean = false;
  public currentFile: string | null = null;
  public currentItem: ManifestItem | null = null;
  public startedAt: number = 0;
  public lastActivity: number = 0;
  public uploadBytesTracked: number = 0;
  public lastUploadBytes: number = 0;
  public lastProgressAt: number = Date.now(); // Last time ANY byte was moved

  private controller: AbortController | null = null;

  // Active streams — tracked so we can force-destroy on abort
  private activeSourceStream: NodeJS.ReadableStream | null = null;
  private activePassThrough: PassThrough | null = null;

  constructor(
    id: number,
    jobId: string,
    manifestId: string,
    sourceDrive: drive_v3.Drive,
    destDrive: drive_v3.Drive,
    rateLimiter: AdaptiveRateLimiter,
    stateManager: MigrationStateManager,
    options: any,
    folderCache: Map<string, string>,
    config: MigrationConfig
  ) {
    this.id = id;
    this.jobId = jobId;
    this.manifestId = manifestId;
    this.sourceDrive = sourceDrive;
    this.destDrive = destDrive;
    this.rateLimiter = rateLimiter;
    this.stateManager = stateManager;
    this.options = options;
    this.folderCache = folderCache;
    this.config = config;
  }

  public get isIdle() { return !this.isBusy && !this.isDead; }

  /**
   * Abort the current transfer.
   * This:
   * 1. Signals the AbortController (best-effort for the API call)
   * 2. Force-destroys both streams to release buffers and close the TCP socket
   */
  public abort(reason?: string): void {
    const tag = `[Worker ${this.id}] ABORT`;
    console.warn(`${tag} | File: ${this.currentFile || 'none'} | Reason: ${reason || 'external'}`);

    if (this.controller && !this.controller.signal.aborted) {
      this.controller.abort();
    }

    // Force-destroy streams — this closes the underlying socket regardless of
    // whether the AbortController was honoured by the API client
    if (this.activeSourceStream) {
      try { (this.activeSourceStream as any).destroy(new Error('Aborted')); } catch (_) {}
      this.activeSourceStream = null;
    }
    if (this.activePassThrough) {
      try { this.activePassThrough.destroy(new Error('Aborted')); } catch (_) {}
      this.activePassThrough = null;
    }
  }

  public async processFile(
    item: ManifestItem,
    releaseWorker: (workerId: number) => void,
    retryJob: (item: ManifestItem) => Promise<void>
  ) {
    this.isBusy = true;
    this.currentFile = item.name;
    this.currentItem = item;
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.lastProgressAt = Date.now();
    this.uploadBytesTracked = 0;
    this.lastUploadBytes = 0;

    // Adaptive timeout — depends on file size
    const transferTimeoutMs = computeTransferTimeout(item.size || 0);

    console.log(
      `[Worker ${this.id}] FILE_START | ` +
      `File: ${item.name} | FileId: ${item.sourceId} | Size: ${item.size} | ` +
      `Bucket: ${this.affinity} | TimeoutMs: ${transferTimeoutMs} | JobId: ${this.jobId}`
    );

    this.controller = new AbortController();

    // Global per-file timeout
    const globalTimeoutHandle = setTimeout(() => {
      const elapsed = Date.now() - this.startedAt;
      console.error(
        `[Worker ${this.id}] FILE_TIMEOUT | File: ${item.name} | FileId: ${item.sourceId} | ` +
        `Elapsed: ${elapsed}ms | TimeoutMs: ${transferTimeoutMs} | BytesMoved: ${this.uploadBytesTracked} | Aborting.`
      );
      this.isDead = true;
      this.abort('global timeout');
    }, transferTimeoutMs);

    try {
      await this.uploadFile(item, this.controller);
      console.log(
        `[Worker ${this.id}] FILE_COMPLETE | File: ${item.name} | FileId: ${item.sourceId} | ` +
        `Size: ${item.size} | BytesMoved: ${this.uploadBytesTracked} | ` +
        `Duration: ${Date.now() - this.startedAt}ms`
      );
    } catch (e: any) {
      const isAbort =
        e.name === 'AbortError' ||
        e.message === 'The operation was aborted' ||
        e.type === 'aborted' ||
        e.message?.includes('Aborted');

      if (isAbort) {
        console.warn(
          `[Worker ${this.id}] FILE_ABORTED | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `BytesMoved: ${this.uploadBytesTracked} | Queuing retry.`
        );
      } else {
        const classification = classifyError(e);
        console.error(
          `[Worker ${this.id}] FILE_FAILED | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `Error: ${e.message} | Status: ${e?.response?.status || 'N/A'} | ` +
          `Classification: ${classification} | BytesMoved: ${this.uploadBytesTracked}`
        );
        if (e.response && e.response.status === 429) this.rateLimiter.reportRateLimit();
      }

      // CRITICAL FIX: Reset manifest state from UPLOADING → QUEUED BEFORE calling retryJob
      // Without this, ManifestStorage.getPendingFiles() (which queries QUEUED status) will
      // never see this item again, and it silently disappears from the queue.
      try {
        await this.stateManager.resetToQueued(item.id);
      } catch (resetErr: any) {
        console.error(
          `[Worker ${this.id}] RESET_QUEUED_FAILED | File: ${item.name} | ` +
          `Error: ${resetErr.message}`
        );
      }

      await retryJob(item);
    } finally {
      clearTimeout(globalTimeoutHandle);
      this.controller = null;
      this.activeSourceStream = null;
      this.activePassThrough = null;
      this.currentFile = null;
      this.currentItem = null;
      this.isBusy = false;
      // Note: isDead is intentionally NOT reset here — if the worker was marked dead
      // by stall detection, it stays dead so FileScheduler replaces it with a fresh one.
      releaseWorker(this.id);
    }
  }

  private async uploadFile(item: ManifestItem, controller: AbortController) {
    // ─── Step 1: Resolve destination parent ───────────────────────────────────
    let destParentId = item.destParentId;
    if (!destParentId) {
      destParentId =
        this.folderCache.get(item.sourceParentId) ||
        this.folderCache.get('root_dest') ||
        this.folderCache.get('root');
      if (!destParentId) {
        throw new UploadError(
          `Parent mapping missing in cache for sourceParentId: ${item.sourceParentId} | File: ${item.name}`
        );
      }
    }

    // ─── Step 2: Duplicate check (checkpoint) ─────────────────────────────────
    const cp = await getCheckpoint(this.jobId, 'file', destParentId, item.sourceId);
    if (cp === 'completed' || cp === 'skipped') {
      console.log(
        `[Worker ${this.id}] FILE_SKIP | File: ${item.name} | FileId: ${item.sourceId} | ` +
        `Reason: Already ${cp} per checkpoint`
      );
      await this.stateManager.commitSuccess(item);
      return;
    }

    this.lastActivity = Date.now();
    this.lastProgressAt = Date.now();

    // ─── Step 3: Determine MIME types ─────────────────────────────────────────
    let targetMimeType = item.mimeType;
    let exportMimeType: string | null = null;

    if (item.mimeType.startsWith('application/vnd.google-apps.')) {
      if (item.mimeType === 'application/vnd.google-apps.document') {
        exportMimeType = this.options.transferDocsAsPdf
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        targetMimeType = this.options.transferDocsAsPdf ? 'application/pdf' : item.mimeType;
      } else if (item.mimeType === 'application/vnd.google-apps.spreadsheet') {
        exportMimeType = this.options.transferDocsAsPdf
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        targetMimeType = this.options.transferDocsAsPdf ? 'application/pdf' : item.mimeType;
      } else if (item.mimeType === 'application/vnd.google-apps.presentation') {
        exportMimeType = this.options.transferDocsAsPdf
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        targetMimeType = this.options.transferDocsAsPdf ? 'application/pdf' : item.mimeType;
      }

      if (!exportMimeType) {
        // Unsupported Google Workspace type — skip gracefully
        console.log(
          `[Worker ${this.id}] FILE_SKIP | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `Reason: Unsupported Google Workspace MIME: ${item.mimeType}`
        );
        await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'skipped');
        await this.stateManager.commitSuccess(item);
        return;
      }
    }

    // ─── Step 4: Download stream with timeout ──────────────────────────────────
    console.log(
      `[Worker ${this.id}] DOWNLOAD_START | File: ${item.name} | FileId: ${item.sourceId} | ` +
      `Size: ${item.size} | ExportMIME: ${exportMimeType || 'none'}`
    );

    let downloadRes: any;
    try {
      if (exportMimeType) {
        downloadRes = await this.sourceDrive.files.export(
          { fileId: item.sourceId, mimeType: exportMimeType },
          { responseType: 'stream', signal: controller.signal }
        );
      } else {
        downloadRes = await this.sourceDrive.files.get(
          { fileId: item.sourceId, alt: 'media' },
          { responseType: 'stream', signal: controller.signal }
        );
      }
    } catch (e: any) {
      throw new DownloadError(
        `DOWNLOAD_START failed for file "${item.name}" (${item.sourceId}): ${e.message}`,
        { isRetryable: true }
      );
    }

    if (!downloadRes || !downloadRes.data) {
      throw new DownloadError(
        `Failed to obtain download stream for file: ${item.name} (${item.sourceId})`,
        { isRetryable: true }
      );
    }

    const srcStream = downloadRes.data;
    this.activeSourceStream = srcStream;

    console.log(
      `[Worker ${this.id}] DOWNLOAD_STREAM_OBTAINED | File: ${item.name} | FileId: ${item.sourceId}`
    );

    // ─── Step 5: Build progress-tracking PassThrough ──────────────────────────
    const progressPT = new PassThrough({
      highWaterMark: this.config.streamBufferSize || 4 * 1024 * 1024
    });
    this.activePassThrough = progressPT;

    let bytesSinceLast = 0;
    let lastSpeedTime = Date.now();
    let lastStallBytes = 0;
    let lastStallCheckTime = Date.now();

    progressPT.on('data', (chunk: Buffer) => {
      this.lastActivity = Date.now();
      this.lastProgressAt = Date.now(); // Update global progress timestamp for stall detection
      this.uploadBytesTracked += chunk.length;
      bytesSinceLast += chunk.length;
      this.stateManager.reportProgressBytes(chunk.length);

      const now = Date.now();
      if (now - lastSpeedTime > 1000) {
        const speed = (bytesSinceLast / (now - lastSpeedTime)) * 1000;
        this.rateLimiter.reportBandwidth(speed);
        lastSpeedTime = now;
        bytesSinceLast = 0;
      }
    });

    progressPT.on('error', (err) => {
      console.error(
        `[Worker ${this.id}] PROGRESS_STREAM_ERROR | File: ${item.name} | ` +
        `FileId: ${item.sourceId} | Error: ${err.message}`
      );
    });

    // Forward errors from source stream into passthrough
    srcStream.on('error', (err: Error) => {
      console.error(
        `[Worker ${this.id}] DOWNLOAD_STREAM_ERROR | File: ${item.name} | ` +
        `FileId: ${item.sourceId} | Error: ${err.message}`
      );
      if (!progressPT.destroyed) progressPT.destroy(err);
    });

    // Abort signal handler — force-destroys streams for immediate socket release
    const abortHandler = () => {
      console.warn(
        `[Worker ${this.id}] ABORT_SIGNAL | File: ${item.name} | Destroying streams.`
      );
      if (!srcStream.destroyed) try { (srcStream as any).destroy(new Error('Aborted')); } catch (_) {}
      if (!progressPT.destroyed) try { progressPT.destroy(new Error('Aborted')); } catch (_) {}
    };
    controller.signal.addEventListener('abort', abortHandler, { once: true });

    // Pipe download → passthrough (non-blocking, drives upload body)
    srcStream.pipe(progressPT);

    // ─── Step 6: Upload stall watchdog ────────────────────────────────────────
    // Independently checks byte progress every 15s.
    // If no bytes for UPLOAD_STALL_TIMEOUT_MS → abort with UploadStallError.
    const uploadStallTimer = setInterval(() => {
      if (controller.signal.aborted) {
        clearInterval(uploadStallTimer);
        return;
      }
      const now = Date.now();
      const stallElapsed = now - lastStallCheckTime;
      if (stallElapsed >= UPLOAD_STALL_CHECK_INTERVAL_MS) {
        const bytesDelta = this.uploadBytesTracked - lastStallBytes;
        if (bytesDelta === 0) {
          // No progress since last check
          const totalStall = now - this.lastProgressAt;
          if (totalStall >= UPLOAD_STALL_TIMEOUT_MS) {
            console.error(
              `[Worker ${this.id}] UPLOAD_STALL_DETECTED | File: ${item.name} | ` +
              `FileId: ${item.sourceId} | BytesTransferred: ${this.uploadBytesTracked} | ` +
              `StallDuration: ${Math.round(totalStall / 1000)}s | Aborting.`
            );
            this.isDead = true;
            this.abort('upload stall');
          }
        } else {
          // Progress was made — reset stall baseline
          lastStallBytes = this.uploadBytesTracked;
          lastStallCheckTime = now;
        }
      }
    }, UPLOAD_STALL_CHECK_INTERVAL_MS);

    // ─── Step 7: Mark as UPLOADING ────────────────────────────────────────────
    await this.stateManager.updateState(item.id, 'UPLOADING');

    console.log(
      `[Worker ${this.id}] UPLOAD_START | File: ${item.name} | FileId: ${item.sourceId} | ` +
      `DestParentId: ${destParentId} | TargetMIME: ${targetMimeType} | ` +
      `TimeoutMs: ${computeTransferTimeout(item.size || 0)}`
    );

    let uploadedFileId: string;

    try {
      // ─── Step 8: Upload with race against a hard socket-destroying timeout ───
      // KEY FIX: We cannot rely on AbortController alone to terminate drive.files.create()
      // when it's already streaming. We use Promise.race() where the reject branch
      // destroys the streams AND the controller, ensuring the HTTP socket is released.
      const uploadPromise = this.destDrive.files.create(
        {
          requestBody: {
            name: item.name,
            parents: [destParentId!],
            mimeType: targetMimeType
          },
          media: { body: progressPT },
          fields: 'id'
        },
        { signal: controller.signal }
      );

      const timeoutPromise = new Promise<never>((_, reject) => {
        // The upload part of the timeout: if 5 minutes pass without upload completing,
        // force-kill the streams. Note: the global timeout already covers this, but
        // this provides an additional safety net specifically for the upload phase.
        const uploadPhaseTimeout = Math.max(
          5 * 60 * 1000,
          computeTransferTimeout(item.size || 0)
        );
        setTimeout(() => {
          if (!controller.signal.aborted) {
            console.error(
              `[Worker ${this.id}] UPLOAD_PHASE_TIMEOUT | File: ${item.name} | ` +
              `BytesMoved: ${this.uploadBytesTracked}`
            );
            // Force-destroy streams to break the upload body pump
            if (!srcStream.destroyed) try { (srcStream as any).destroy(); } catch (_) {}
            if (!progressPT.destroyed) try { progressPT.destroy(); } catch (_) {}
          }
          reject(new UploadTimeoutError(
            `Upload phase timeout for file "${item.name}" (${item.sourceId})`,
            Date.now() - this.startedAt,
            this.uploadBytesTracked
          ));
        }, uploadPhaseTimeout);
      });

      const createRes = await Promise.race([uploadPromise, timeoutPromise]);

      if (!createRes.data || !createRes.data.id) {
        throw new UploadError(
          `No file ID returned from Google Drive API for ${item.name} (${item.sourceId})`
        );
      }

      uploadedFileId = createRes.data.id;
      console.log(
        `[Worker ${this.id}] UPLOAD_COMPLETE | File: ${item.name} | FileId: ${item.sourceId} | ` +
        `DestFileId: ${uploadedFileId} | BytesTransferred: ${this.uploadBytesTracked} | ` +
        `Duration: ${Date.now() - this.startedAt}ms`
      );
    } finally {
      clearInterval(uploadStallTimer);
      controller.signal.removeEventListener('abort', abortHandler);
      // Guaranteed stream cleanup regardless of success or failure
      if (!progressPT.destroyed) try { progressPT.destroy(); } catch (_) {}
      if (!srcStream.destroyed) try { (srcStream as any).destroy(); } catch (_) {}
    }

    // ─── Step 9: Commit checkpoint and mark SUCCESS ───────────────────────────
    await this.stateManager.updateState(item.id, 'VERIFYING');
    await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'completed');
    await this.stateManager.commitSuccess(item);
    this.rateLimiter.reportSuccess();

    console.log(
      `[Worker ${this.id}] FILE_SUCCESS | File: ${item.name} | FileId: ${item.sourceId} | ` +
      `DestFileId: ${uploadedFileId} | Size: ${item.size} | UploadedBytes: ${this.uploadBytesTracked}`
    );
  }
}
