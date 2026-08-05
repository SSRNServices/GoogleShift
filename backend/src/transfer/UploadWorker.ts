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

// TASK 3: MONKEY-PATCH PASSTHROUGH TO CAPTURE STACK TRACE ON PUSH AFTER EOF
let monkeyPatchInstalled = false;
function installPassThroughMonkeyPatch() {
  if (monkeyPatchInstalled) return;
  monkeyPatchInstalled = true;

  const originalPush = PassThrough.prototype.push;
  PassThrough.prototype.push = function (chunk: any, encoding?: any) {
    if (this.readableEnded || (this as any)._readableState?.ended) {
      console.error(
        `\n${'='.repeat(80)}\n` +
        `[CRITICAL_STREAM_DEBUG] PUSH_AFTER_EOF DETECTED!\n` +
        `Chunk: ${chunk ? (chunk.length ? `${chunk.length} bytes` : typeof chunk) : 'null/EOF'}\n` +
        `ReadableEnded: ${this.readableEnded} | Destroyed: ${this.destroyed} | Closed: ${(this as any).closed}\n` +
        `STACK TRACE:\n${new Error().stack}\n` +
        `${'='.repeat(80)}\n`
      );
    }
    return originalPush.call(this, chunk, encoding);
  };

  const originalWrite = PassThrough.prototype.write;
  PassThrough.prototype.write = function (chunk: any, encoding?: any, cb?: any) {
    if (this.writableEnded || (this as any)._writableState?.ended) {
      console.error(
        `\n${'='.repeat(80)}\n` +
        `[CRITICAL_STREAM_DEBUG] WRITE_AFTER_END DETECTED!\n` +
        `WritableEnded: ${this.writableEnded} | Destroyed: ${this.destroyed}\n` +
        `STACK TRACE:\n${new Error().stack}\n` +
        `${'='.repeat(80)}\n`
      );
    }
    return originalWrite.call(this, chunk, encoding, cb);
  };

  const originalEnd = PassThrough.prototype.end;
  PassThrough.prototype.end = function (chunk?: any, encoding?: any, cb?: any) {
    if (this.writableEnded || (this as any)._writableState?.ended) {
      // Ignore duplicate end if harmless, but log if chunk provided
      if (chunk) {
        console.error(
          `\n${'='.repeat(80)}\n` +
          `[CRITICAL_STREAM_DEBUG] END_WITH_CHUNK_AFTER_ENDED DETECTED!\n` +
          `WritableEnded: ${this.writableEnded}\n` +
          `STACK TRACE:\n${new Error().stack}\n` +
          `${'='.repeat(80)}\n`
        );
      }
    }
    return originalEnd.call(this, chunk, encoding, cb);
  };
}

installPassThroughMonkeyPatch();

const MIN_EXPECTED_SPEED_BYTES_PER_SEC = 512 * 1024; // 512 KB/s
const MIN_FILE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FILE_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours
const UPLOAD_STALL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const UPLOAD_STALL_CHECK_INTERVAL_MS = 15_000; // 15 seconds

function computeTransferTimeout(fileSizeBytes: number): number {
  const sizeBasedTimeout = (fileSizeBytes / MIN_EXPECTED_SPEED_BYTES_PER_SEC) * 1000;
  return Math.min(MAX_FILE_TIMEOUT_MS, Math.max(MIN_FILE_TIMEOUT_MS, sizeBasedTimeout));
}

function classifyErrorDetails(e: any): string {
  const msg = e?.message || '';
  if (msg.includes('push() after EOF') || msg.includes('ERR_STREAM_PUSH_AFTER_EOF') || e?.name === 'StreamLifecycleError') {
    return 'Stream Lifecycle Error';
  }
  if (e?.name === 'DownloadTimeoutError' || e?.name === 'UploadTimeoutError' || msg.includes('timeout')) {
    return 'Timeout Error';
  }
  if (e?.name === 'DownloadStallError' || e?.name === 'UploadStallError' || msg.includes('stall')) {
    return 'Network Stall Error';
  }
  if (e?.name === 'GoogleApiError' || e?.response?.status || msg.includes('Google Drive API')) {
    return 'Google API Error';
  }
  if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('socket hang up')) {
    return 'Network Connection Error';
  }
  const generalClass = classifyError(e);
  if (generalClass === 'permanent') return 'Permanent Error';
  if (generalClass === 'retryable') return 'Retryable Network Error';
  return 'Transfer Error';
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
  public lastProgressAt: number = Date.now();

  private controller: AbortController | null = null;
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

  public abort(reason?: string): void {
    const tag = `[Worker ${this.id}] ABORT`;
    console.warn(`${tag} | File: ${this.currentFile || 'none'} | Reason: ${reason || 'external'}`);

    if (this.controller && !this.controller.signal.aborted) {
      this.controller.abort();
    }

    this.cleanupActiveStreams();
  }

  private cleanupActiveStreams(): void {
    if (this.activeSourceStream) {
      try {
        if (this.activePassThrough) this.activeSourceStream.unpipe(this.activePassThrough);
        this.activeSourceStream.removeAllListeners();
        (this.activeSourceStream as any).destroy?.();
      } catch (_) {}
      this.activeSourceStream = null;
    }
    if (this.activePassThrough) {
      try {
        this.activePassThrough.removeAllListeners();
        this.activePassThrough.destroy?.();
      } catch (_) {}
      this.activePassThrough = null;
    }
  }

  private logStreamDiagnostics(stage: string, item: ManifestItem, stream: any): void {
    if (!stream) return;
    console.log(
      `[Worker ${this.id}] STREAM_DIAGNOSTICS [${stage}] | File: ${item.name} | ` +
      `Constructor: ${stream.constructor?.name || 'unknown'} | ` +
      `Readable: ${!!stream.readable} | Ended: ${!!stream.readableEnded} | ` +
      `Destroyed: ${!!stream.destroyed} | Closed: ${!!stream.closed} | ` +
      `Paused: ${typeof stream.isPaused === 'function' ? stream.isPaused() : 'N/A'} | ` +
      `DataListeners: ${typeof stream.listenerCount === 'function' ? stream.listenerCount('data') : 'N/A'} | ` +
      `BytesMoved: ${this.uploadBytesTracked}/${item.size || 'unknown'}`
    );
  }

  public async processFile(
    item: ManifestItem,
    releaseWorker: (workerId: number) => void,
    retryJob: (item: ManifestItem) => Promise<void>
  ) {
    this.isBusy = true;

    // PRE-EXECUTION DB MANIFEST CHECK (ISSUE 7, 8, 9)
    try {
      const dbRow = await prisma.migrationManifest.findUnique({
        where: { jobId_id: { jobId: this.manifestId || this.jobId, id: item.id } },
        select: { status: true, retryCount: true }
      });
      if (dbRow && (dbRow.status === 'FAILED' || dbRow.status === 'SUCCESS')) {
        console.warn(
          `[Worker ${this.id}] REJECT_ASSIGNMENT | File: ${item.name} | ` +
          `FileId: ${item.sourceId} | DB Status is already ${dbRow.status}. Skipping execution.`
        );
        this.isBusy = false;
        this.currentFile = null;
        this.currentItem = null;
        releaseWorker(this.id);
        return;
      }
    } catch (_) {}

    this.currentFile = item.name;
    this.currentItem = item;
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.lastProgressAt = Date.now();
    this.uploadBytesTracked = 0;
    this.lastUploadBytes = 0;

    const transferTimeoutMs = computeTransferTimeout(item.size || 0);

    console.log(
      `[Worker ${this.id}] FILE_START | ` +
      `File: ${item.name} | FileId: ${item.sourceId} | Size: ${item.size} | ` +
      `Bucket: ${this.affinity} | TimeoutMs: ${transferTimeoutMs} | JobId: ${this.jobId}`
    );

    this.controller = new AbortController();

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

      const classification = classifyErrorDetails(e);
      const formattedErrorMsg = `${e.message || 'Transfer failed'} | Classification: ${classification}`;

      if (isAbort) {
        console.warn(
          `[Worker ${this.id}] FILE_ABORTED | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `BytesMoved: ${this.uploadBytesTracked} | Queuing retry.`
        );
      } else {
        console.error(
          `[Worker ${this.id}] FILE_FAILED | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `Error: ${e.message} | Classification: ${classification} | BytesMoved: ${this.uploadBytesTracked}`
        );
        if (e.response && e.response.status === 429) this.rateLimiter.reportRateLimit();
      }

      // Persist failure details in checkpoint
      try {
        const destParentId = item.destParentId || this.folderCache.get(item.sourceParentId) || 'root';
        await saveCheckpoint(this.jobId, 'file', destParentId, item.sourceId, 'failed', {
          fileName: item.name,
          mimeType: item.mimeType,
          size: item.size,
          error: formattedErrorMsg
        });
      } catch (_) {}

      // Atomic retry delegation without pre-emptive resetToQueued
      await retryJob(item);
    } finally {
      clearTimeout(globalTimeoutHandle);
      this.cleanupActiveStreams();
      this.controller = null;
      this.currentFile = null;
      this.currentItem = null;
      this.isBusy = false;
      releaseWorker(this.id);
    }
  }

  private async uploadFile(item: ManifestItem, controller: AbortController) {
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

    let targetMimeType = item.mimeType || 'application/octet-stream';
    let exportMimeType: string | null = null;

    if (item.mimeType.startsWith('application/vnd.google-apps.')) {
      if (item.mimeType === 'application/vnd.google-apps.document') {
        exportMimeType = this.options.transferDocsAsPdf
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        targetMimeType = this.options.transferDocsAsPdf ? 'application/pdf' : exportMimeType;
      } else if (item.mimeType === 'application/vnd.google-apps.spreadsheet') {
        exportMimeType = this.options.transferDocsAsPdf
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        targetMimeType = this.options.transferDocsAsPdf ? 'application/pdf' : exportMimeType;
      } else if (item.mimeType === 'application/vnd.google-apps.presentation') {
        exportMimeType = this.options.transferDocsAsPdf
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        targetMimeType = this.options.transferDocsAsPdf ? 'application/pdf' : exportMimeType;
      }

      if (!exportMimeType) {
        console.log(
          `[Worker ${this.id}] FILE_SKIP | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `Reason: Unsupported Google Workspace MIME: ${item.mimeType}`
        );
        await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'skipped');
        await this.stateManager.commitSuccess(item);
        return;
      }
    }

    console.log(
      `[Worker ${this.id}] DOWNLOAD_START | File: ${item.name} | FileId: ${item.sourceId} | ` +
      `Size: ${item.size} | TargetMIME: ${targetMimeType} | ExportMIME: ${exportMimeType || 'none'}`
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
      this.lastProgressAt = Date.now();
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

    progressPT.on('error', (err: Error) => {
      console.error(
        `[Worker ${this.id}] PROGRESS_STREAM_ERROR | File: ${item.name} | Error: ${err.message}`
      );
    });

    srcStream.on('error', (err: Error) => {
      console.error(
        `[Worker ${this.id}] DOWNLOAD_STREAM_ERROR | File: ${item.name} | Error: ${err.message}`
      );
      try { srcStream.unpipe(progressPT); } catch (_) {}
      if (!progressPT.destroyed) try { progressPT.destroy(err); } catch (_) {}
    });

    const abortHandler = () => {
      console.warn(`[Worker ${this.id}] ABORT_SIGNAL | File: ${item.name} | Cleaning streams.`);
      this.cleanupActiveStreams();
    };
    controller.signal.addEventListener('abort', abortHandler, { once: true });

    // CRITICAL STREAM LIFECYCLE FIX (TASK 4 & 6):
    // Pass { end: false } to pipe() and explicitly unpipe on srcStream 'end'/'close'
    // BEFORE calling progressPT.end(). This prevents trailing socket close events on srcStream
    // from attempting push()/write() on progressPT after progressPT is ended!
    srcStream.pipe(progressPT, { end: false });

    srcStream.once('end', () => {
      try { srcStream.unpipe(progressPT); } catch (_) {}
      if (!progressPT.writableEnded && !(progressPT as any)._writableState?.ended) {
        try { progressPT.end(); } catch (_) {}
      }
    });

    srcStream.once('close', () => {
      try { srcStream.unpipe(progressPT); } catch (_) {}
    });

    // PRE-UPLOAD STREAM STATE VALIDATION (ISSUE 2)
    if (
      srcStream.readableEnded ||
      srcStream.destroyed ||
      (srcStream as any).closed ||
      progressPT.readableEnded ||
      progressPT.destroyed ||
      progressPT.closed
    ) {
      this.cleanupActiveStreams();
      throw new DownloadError(
        `Download stream for file "${item.name}" reached EOF or was destroyed before upload creation.`,
        { isRetryable: true }
      );
    }

    this.logStreamDiagnostics('PRE_UPLOAD', item, progressPT);

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
          const totalStall = now - this.lastProgressAt;
          if (totalStall >= UPLOAD_STALL_TIMEOUT_MS) {
            console.error(
              `[Worker ${this.id}] UPLOAD_STALL_DETECTED | File: ${item.name} | ` +
              `StallDuration: ${Math.round(totalStall / 1000)}s | Aborting.`
            );
            this.isDead = true;
            this.abort('upload stall');
          }
        } else {
          lastStallBytes = this.uploadBytesTracked;
          lastStallCheckTime = now;
        }
      }
    }, UPLOAD_STALL_CHECK_INTERVAL_MS);

    await this.stateManager.updateState(item.id, 'UPLOADING');

    console.log(
      `[Worker ${this.id}] UPLOAD_START | File: ${item.name} | FileId: ${item.sourceId} | ` +
      `TargetMIME: ${targetMimeType}`
    );

    let uploadedFileId: string;

    try {
      const uploadPromise = this.destDrive.files.create(
        {
          requestBody: {
            name: item.name,
            parents: [destParentId!],
            mimeType: targetMimeType
          },
          media: {
            mimeType: targetMimeType,
            body: progressPT
          },
          fields: 'id'
        },
        { signal: controller.signal }
      );

      const timeoutPromise = new Promise<never>((_, reject) => {
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
            this.cleanupActiveStreams();
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
      this.logStreamDiagnostics('POST_UPLOAD', item, progressPT);
    } finally {
      clearInterval(uploadStallTimer);
      controller.signal.removeEventListener('abort', abortHandler);
      this.cleanupActiveStreams();
    }

    await this.stateManager.updateState(item.id, 'VERIFYING');
    await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'completed', {
      fileName: item.name,
      mimeType: targetMimeType,
      size: item.size
    });
    await this.stateManager.commitSuccess(item);
    this.rateLimiter.reportSuccess();

    console.log(
      `[Worker ${this.id}] FILE_SUCCESS | File: ${item.name} | FileId: ${item.sourceId} | ` +
      `DestFileId: ${uploadedFileId} | Size: ${item.size}`
    );
  }
}
