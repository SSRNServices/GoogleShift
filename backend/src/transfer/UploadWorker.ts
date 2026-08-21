// @ts-nocheck
import { drive_v3 } from 'googleapis';
import { ManifestItem } from '../utils/ManifestStorage';
import { AdaptiveRateLimiter } from './AdaptiveRateLimiter';
import { MigrationStateManager } from '../services/MigrationStateManager';
import { getCheckpoint, saveCheckpoint } from '../utils/database';
import { Transform, TransformCallback } from 'stream';
import {
  DownloadError,
  DownloadTimeoutError,
  UploadError,
  UploadTimeoutError,
  UploadStallError,
  GoogleApiError,
  StreamLifecycleError,
  classifyError,
  formatDetailedError
} from '../utils/errors';
import { MigrationConfig } from './types';
import { prisma } from '../utils/database';

import {
  toNodeReadable,
  assertNodeReadable,
  logBodyDiagnostics,
  UploadStreamTypeError
} from '../utils/StreamNormalizer';

export class ProgressTransform extends Transform {
  private onChunk: (chunkLength: number) => void;

  constructor(onChunk: (chunkLength: number) => void, highWaterMark?: number) {
    super({ highWaterMark });
    this.onChunk = onChunk;
  }

  _transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback): void {
    if (chunk && chunk.length) {
      this.onChunk(chunk.length);
    }
    callback(null, chunk);
  }
}

const MIN_EXPECTED_SPEED_BYTES_PER_SEC = 512 * 1024; // 512 KB/s
const MIN_FILE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FILE_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours
const FIRST_BYTE_TIMEOUT_MS = 60_000; // 60 seconds for first byte
const UPLOAD_STALL_TIMEOUT_MS = 60_000; // 60 seconds of zero bytes progress
const UPLOAD_STALL_CHECK_INTERVAL_MS = 10_000; // 10 seconds check interval
const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024; // 8 MB

function computeTransferTimeout(fileSizeBytes: number): number {
  const sizeBasedTimeout = (fileSizeBytes / MIN_EXPECTED_SPEED_BYTES_PER_SEC) * 1000;
  return Math.min(MAX_FILE_TIMEOUT_MS, Math.max(MIN_FILE_TIMEOUT_MS, sizeBasedTimeout));
}

function classifyErrorDetails(e: any): string {
  const msg = e?.message || '';
  if (msg.includes('pipe is not a function') || msg.includes('UPLOAD_STREAM_TYPE_ERROR') || e?.name === 'UploadStreamTypeError' || e instanceof UploadStreamTypeError) {
    return 'Upload Stream Type Error';
  }
  if (msg.includes('push() after EOF') || msg.includes('ERR_STREAM_PUSH_AFTER_EOF') || e?.name === 'StreamLifecycleError' || e instanceof StreamLifecycleError) {
    return 'Stream Lifecycle Error';
  }
  if (e?.name === 'DownloadTimeoutError' || e?.name === 'UploadTimeoutError' || msg.includes('timeout')) {
    return 'Timeout Error';
  }
  if (e?.name === 'DownloadStallError' || e?.name === 'UploadStallError' || msg.includes('stall')) {
    return 'Network Stall Error';
  }
  if (e?.name === 'GoogleApiError' || e?.response?.status || msg.includes('Google Drive API')) {
    return `Google API Error (${e?.response?.status || e?.status || 'N/A'})`;
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
  private activePassThrough: ProgressTransform | null = null;

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

    this.cleanupActiveStreams(true);
  }

  private cleanupActiveStreams(isErrorOrAbort: boolean = false): void {
    if (this.activeSourceStream) {
      try {
        this.activeSourceStream.removeAllListeners();
        if (isErrorOrAbort && typeof (this.activeSourceStream as any).destroy === 'function' && !(this.activeSourceStream as any).destroyed) {
          (this.activeSourceStream as any).destroy();
        }
      } catch (_) {}
      this.activeSourceStream = null;
    }
    if (this.activePassThrough) {
      try {
        this.activePassThrough.removeAllListeners();
        if (isErrorOrAbort && typeof this.activePassThrough.destroy === 'function' && !this.activePassThrough.destroyed) {
          this.activePassThrough.destroy();
        }
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

    // PRE-EXECUTION IN-MEMORY STATUS CHECK
    if (item.status === 'SUCCESS' || item.status === 'FAILED') {
      this.isBusy = false;
      this.currentFile = null;
      this.currentItem = null;
      releaseWorker(this.id);
      return;
    }

    this.currentFile = item.name;
    this.currentItem = item;
    this.stateManager.activeFileName = item.name;
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.lastProgressAt = Date.now();
    this.uploadBytesTracked = 0;
    this.lastUploadBytes = 0;

    const transferTimeoutMs = computeTransferTimeout(item.size || 0);

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
    } catch (e: any) {
      const isAbort =
        e.name === 'AbortError' ||
        e.message === 'The operation was aborted' ||
        e.type === 'aborted' ||
        e.message?.includes('Aborted');

      const detailedMsg = formatDetailedError(e);
      const classification = classifyErrorDetails(e);
      const generalClass = classifyError(e);
      const formattedErrorMsg = `${detailedMsg} | Classification: ${classification}`;

      if (isAbort) {
        console.warn(
          `[Worker ${this.id}] FILE_ABORTED | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `BytesMoved: ${this.uploadBytesTracked} | Queuing retry.`
        );
      } else {
        console.error(
          `[Worker ${this.id}] FILE_FAILED | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `Details: ${detailedMsg} | Classification: ${classification} | BytesMoved: ${this.uploadBytesTracked}`
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

      if (generalClass === 'permanent') {
        console.warn(
          `[Worker ${this.id}] NON_RETRIABLE_ERROR | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `Error: ${detailedMsg} | Classification: ${classification}`
        );
        await this.stateManager.updateState(item.id, 'FAILED').catch(() => {});
      } else {
        await retryJob(item);
      }
    } finally {
      clearTimeout(globalTimeoutHandle);
      this.cleanupActiveStreams(false);
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

    // ── IDEMPOTENCY / DUPLICATE CHECK ───────────────────────────────────────────
    if (item.createdDestId) {
      try {
        const existing = await this.destDrive.files.get({
          fileId: item.createdDestId,
          fields: 'id, trashed'
        }, { signal: controller.signal });
        if (existing.data && !existing.data.trashed) {
          console.log(
            `[Worker ${this.id}] FILE_ALREADY_MIGRATED | File: ${item.name} | ` +
            `DestFileId: ${item.createdDestId}`
          );
          await this.stateManager.commitSuccess(item);
          return;
        }
      } catch (_) {}
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

    // ── TINY FILE FAST PATH (Files < 1 MB non-Workspace) ──────────────────────
    const isTinyFile = !exportMimeType && (Number(item.size || 0) < 1024 * 1024);

    if (isTinyFile) {
      let downloadRes: any;
      try {
        downloadRes = await this.sourceDrive.files.get(
          { fileId: item.sourceId, alt: 'media' },
          { responseType: 'arraybuffer', signal: controller.signal }
        );
      } catch (e: any) {
        throw new DownloadError(
          `DOWNLOAD_TINY failed for file "${item.name}" (${item.sourceId}): ${formatDetailedError(e)}`,
          { isRetryable: true }
        );
      }

      if (!downloadRes || !downloadRes.data) {
        throw new DownloadError(
          `Failed to obtain download buffer for tiny file: ${item.name} (${item.sourceId})`,
          { isRetryable: true }
        );
      }

      const data = downloadRes.data;
      const isBufferData = Buffer.isBuffer(data) || data instanceof ArrayBuffer || (data && typeof data.pipe !== 'function');

      if (isBufferData) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.uploadBytesTracked = buffer.length;
        this.stateManager.reportProgressBytes(buffer.length);
        this.lastActivity = Date.now();
        this.lastProgressAt = Date.now();

        const uploadStream = toNodeReadable(buffer);
        assertNodeReadable(uploadStream, `TINY upload for ${item.name}`);

        let createRes: any;
        try {
          createRes = await this.destDrive.files.create(
            {
              requestBody: {
                name: item.name,
                parents: [destParentId!],
                mimeType: targetMimeType
              },
              media: {
                mimeType: targetMimeType,
                body: uploadStream
              },
              fields: 'id'
            },
            { signal: controller.signal }
          );
        } catch (e: any) {
          throw new UploadError(
            `UPLOAD_TINY failed for file "${item.name}" (${item.sourceId}): ${formatDetailedError(e)}`,
            { isRetryable: classifyError(e) === 'retryable' }
          );
        }

        if (!createRes.data || !createRes.data.id) {
          throw new UploadError(
            `No file ID returned for tiny file: ${item.name} (${item.sourceId})`
          );
        }

        const uploadedFileId = createRes.data.id;
        await this.stateManager.commitSuccess(item);
        this.rateLimiter.reportSuccess();

        const totalDurationMs = Date.now() - this.startedAt;
        console.log(
          `[Worker ${this.id}] FILE_SUCCESS (TINY_FAST_PATH) | File: ${item.name} | ` +
          `Size: ${buffer.length} B | DurationMs: ${totalDurationMs}`
        );
        return;
      }
    }

    console.log(
      `[Worker ${this.id}] DOWNLOAD_START | File: ${item.name} | FileId: ${item.sourceId} | ` +
      `Size: ${item.size} | TargetMIME: ${targetMimeType} | ExportMIME: ${exportMimeType || 'none'}`
    );

    // ── FIRST-BYTE TIMEOUT PROTECTION ───────────────────────────────────────────
    let firstByteReceived = false;
    const firstByteTimer = setTimeout(() => {
      if (!firstByteReceived && !controller.signal.aborted) {
        console.error(
          `[Worker ${this.id}] FIRST_BYTE_TIMEOUT | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `No data received within ${FIRST_BYTE_TIMEOUT_MS / 1000}s of DOWNLOAD_START. Aborting.`
        );
        this.isDead = true;
        this.abort('first byte timeout');
      }
    }, FIRST_BYTE_TIMEOUT_MS);

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
      clearTimeout(firstByteTimer);
      throw new DownloadError(
        `DOWNLOAD_START failed for file "${item.name}" (${item.sourceId}): ${formatDetailedError(e)}`,
        { isRetryable: true }
      );
    }

    if (!downloadRes || !downloadRes.data) {
      clearTimeout(firstByteTimer);
      throw new DownloadError(
        `Failed to obtain download stream for file: ${item.name} (${item.sourceId})`,
        { isRetryable: true }
      );
    }

    const srcStream = downloadRes.data;
    this.activeSourceStream = srcStream;

    let bytesSinceLast = 0;
    let lastSpeedTime = Date.now();
    let lastStallBytes = 0;
    let lastStallCheckTime = Date.now();

    const progressPT = new ProgressTransform(
      (chunkLength: number) => {
        if (!firstByteReceived) {
          firstByteReceived = true;
          clearTimeout(firstByteTimer);
        }
        this.lastActivity = Date.now();
        this.lastProgressAt = Date.now();
        this.uploadBytesTracked += chunkLength;
        bytesSinceLast += chunkLength;
        this.stateManager.reportProgressBytes(chunkLength);

        const now = Date.now();
        if (now - lastSpeedTime > 1000) {
          const speed = (bytesSinceLast / (now - lastSpeedTime)) * 1000;
          this.rateLimiter.reportBandwidth(speed);
          lastSpeedTime = now;
          bytesSinceLast = 0;
        }
      },
      (item.size || 0) < 10 * 1024 * 1024 ? 256 * 1024 : (this.config.streamBufferSize || 4 * 1024 * 1024)
    );
    this.activePassThrough = progressPT;

    progressPT.on('error', (err: Error) => {
      console.error(
        `[Worker ${this.id}] PROGRESS_STREAM_ERROR | File: ${item.name} | Error: ${err.message}`
      );
    });

    srcStream.on('error', (err: Error) => {
      console.error(
        `[Worker ${this.id}] DOWNLOAD_STREAM_ERROR | File: ${item.name} | Error: ${err.message}`
      );
      if (!progressPT.destroyed) try { progressPT.destroy(err); } catch (_) {}
    });

    const abortHandler = () => {
      clearTimeout(firstByteTimer);
      console.warn(`[Worker ${this.id}] ABORT_SIGNAL | File: ${item.name} | Cleaning streams.`);
      this.cleanupActiveStreams(true);
    };
    controller.signal.addEventListener('abort', abortHandler, { once: true });

    srcStream.pipe(progressPT);

    if (
      srcStream.readableEnded ||
      srcStream.destroyed ||
      (srcStream as any).closed ||
      progressPT.readableEnded ||
      progressPT.destroyed ||
      progressPT.closed
    ) {
      clearTimeout(firstByteTimer);
      this.cleanupActiveStreams(true);
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
      const normalizedUploadStream = toNodeReadable(progressPT);
      assertNodeReadable(normalizedUploadStream, item.name);

      const uploadPromise = (async () => {
        // Use resumable upload for large files >= 8 MB
        const useResumable = (item.size || 0) >= RESUMABLE_UPLOAD_THRESHOLD_BYTES && !exportMimeType;
        if (useResumable) {
          try {
            return await this.uploadFileResumable(
              item,
              destParentId!,
              targetMimeType,
              normalizedUploadStream,
              controller
            );
          } catch (resumableErr) {
            console.warn(
              `[Worker ${this.id}] RESUMABLE_UPLOAD_FALLBACK | File: ${item.name} | ` +
              `Error: ${formatDetailedError(resumableErr)} | Falling back to standard create.`
            );
          }
        }

        const createRes = await this.destDrive.files.create(
          {
            requestBody: {
              name: item.name,
              parents: [destParentId!],
              mimeType: targetMimeType
            },
            media: {
              mimeType: targetMimeType,
              body: normalizedUploadStream
            },
            fields: 'id'
          },
          { signal: controller.signal }
        );
        return createRes.data?.id;
      })();

      const timeoutPromise = new Promise<never>((_, reject) => {
        const uploadPhaseTimeout = Math.max(
          15 * 60 * 1000,
          computeTransferTimeout(item.size || 0)
        );
        setTimeout(() => {
          if (!controller.signal.aborted) {
            console.error(
              `[Worker ${this.id}] UPLOAD_PHASE_TIMEOUT | File: ${item.name} | ` +
              `BytesMoved: ${this.uploadBytesTracked}`
            );
            this.cleanupActiveStreams(true);
          }
          reject(new UploadTimeoutError(
            `Upload phase timeout for file "${item.name}" (${item.sourceId})`,
            Date.now() - this.startedAt,
            this.uploadBytesTracked
          ));
        }, uploadPhaseTimeout);
      });

      uploadedFileId = await Promise.race([uploadPromise, timeoutPromise]);

      if (!uploadedFileId) {
        throw new UploadError(
          `No file ID returned from Google Drive API for ${item.name} (${item.sourceId})`
        );
      }

      this.logStreamDiagnostics('POST_UPLOAD', item, progressPT);
    } catch (err) {
      this.cleanupActiveStreams(true);
      throw err;
    } finally {
      clearTimeout(firstByteTimer);
      clearInterval(uploadStallTimer);
      controller.signal.removeEventListener('abort', abortHandler);
    }

    await this.stateManager.updateState(item.id, 'VERIFYING');
    await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'completed', {
      fileName: item.name,
      mimeType: targetMimeType,
      size: item.size
    });
    await this.stateManager.commitSuccess(item);
    this.rateLimiter.reportSuccess();

    const totalDurationMs = Date.now() - this.startedAt;
    const mbps = (item.size || 0) > 0 && totalDurationMs > 0 ? (((item.size || 0) / (1024 * 1024)) / (totalDurationMs / 1000)).toFixed(2) : '0.00';

    console.log(
      `[Worker ${this.id}] FILE_SUCCESS | File: ${item.name} | FileId: ${item.sourceId} | ` +
      `DestFileId: ${uploadedFileId} | Size: ${item.size} | DurationMs: ${totalDurationMs} | Speed: ${mbps} MB/s`
    );
  }

  /**
   * Resumable upload implementation for large files >= 8 MB.
   * Initiates a Google Drive resumable session and streams data.
   */
  private async uploadFileResumable(
    item: ManifestItem,
    destParentId: string,
    targetMimeType: string,
    uploadStream: NodeJS.ReadableStream,
    controller: AbortController
  ): Promise<string> {
    const authClient = (this.destDrive as any).context?._options?.auth;
    let token: string | null = null;
    if (authClient) {
      if (typeof authClient.getAccessToken === 'function') {
        const tokenRes = await authClient.getAccessToken();
        token = typeof tokenRes === 'string' ? tokenRes : tokenRes?.token;
      }
      if (!token && typeof authClient.getRequestHeaders === 'function') {
        const headers = await authClient.getRequestHeaders();
        token = headers?.Authorization || headers?.authorization;
        if (token && token.startsWith('Bearer ')) token = token.substring(7);
      }
    }

    if (!token) {
      throw new Error('Resumable upload failed: unable to extract destination access token.');
    }

    // Step 1: Initiate session
    const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': targetMimeType,
        'X-Upload-Content-Length': String(item.size || 0)
      },
      body: JSON.stringify({
        name: item.name,
        parents: [destParentId],
        mimeType: targetMimeType
      }),
      signal: controller.signal
    });

    if (!initRes.ok) {
      throw new UploadError(`Resumable session init failed with status ${initRes.status}`, {
        httpStatus: initRes.status,
        isRetryable: initRes.status === 429 || initRes.status >= 500
      });
    }

    const sessionUri = initRes.headers.get('location');
    if (!sessionUri) {
      throw new UploadError('Resumable session init did not return Location header.');
    }

    // Step 2: Stream content to sessionUri
    const putRes = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'Content-Type': targetMimeType
      },
      body: uploadStream as any,
      signal: controller.signal,
      // @ts-ignore
      duplex: 'half'
    });

    if (!putRes.ok && putRes.status !== 308) {
      throw new UploadError(`Resumable upload stream failed with status ${putRes.status}`, {
        httpStatus: putRes.status,
        isRetryable: putRes.status === 429 || putRes.status >= 500
      });
    }

    const bodyData = await putRes.json();
    return bodyData.id;
  }
}


