// @ts-nocheck
import { drive_v3 } from 'googleapis';
import { ManifestItem } from '../utils/ManifestStorage';
import { AdaptiveRateLimiter } from './AdaptiveRateLimiter';
import { MigrationStateManager } from '../services/MigrationStateManager';
import { getCheckpoint, saveCheckpoint } from '../utils/database';
import { PassThrough } from 'stream';
import { DownloadError, UploadError } from '../utils/errors';
import { MigrationConfig } from './types';

/** Maximum time allowed for a single file transfer (download + upload combined) */
const FILE_TRANSFER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** If no upload progress bytes are received for this long, abort the operation */
const UPLOAD_STALL_TIMEOUT_MS = 60 * 1000; // 1 minute

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
  public lastUploadCheckTime: number = 0;

  private controller: AbortController | null = null;

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

  public abort() {
    if (this.controller) this.controller.abort();
  }

  public async processFile(
    item: ManifestItem,
    releaseWorker: (workerId: number) => void,
    retryJob: (item: ManifestItem) => void
  ) {
    this.isBusy = true;
    this.currentFile = item.name;
    this.currentItem = item;
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.uploadBytesTracked = 0;
    this.lastUploadBytes = 0;
    this.lastUploadCheckTime = Date.now();

    console.log(
      `[Worker ${this.id}] FILE_START | Bucket: ${this.affinity} | File: ${item.name} | ` +
      `Size: ${item.size} | FileId: ${item.sourceId} | JobId: ${this.jobId}`
    );

    this.controller = new AbortController();

    // Global per-file timeout: abort after FILE_TRANSFER_TIMEOUT_MS
    const globalTimeoutHandle = setTimeout(() => {
      console.error(
        `[Worker ${this.id}] FILE_TIMEOUT | File: ${item.name} | FileId: ${item.sourceId} | ` +
        `Elapsed: ${Date.now() - this.startedAt}ms | Aborting.`
      );
      if (this.controller) this.controller.abort();
    }, FILE_TRANSFER_TIMEOUT_MS);

    try {
      await this.uploadFile(item, this.controller);
      console.log(
        `[Worker ${this.id}] FILE_COMPLETE | File: ${item.name} | FileId: ${item.sourceId} | ` +
        `Size: ${item.size} | Duration: ${Date.now() - this.startedAt}ms`
      );
    } catch (e: any) {
      if (
        e.name === 'AbortError' ||
        e.message === 'The operation was aborted' ||
        e.type === 'aborted'
      ) {
        console.warn(
          `[Worker ${this.id}] FILE_ABORTED | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `Reason: Aborted (timeout or external cancellation) | Queuing retry.`
        );
        retryJob(item);
      } else {
        console.error(
          `[Worker ${this.id}] FILE_FAILED | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `Error: ${e.message} | Status: ${e?.response?.status || 'N/A'}`
        );
        if (e.response && e.response.status === 429) this.rateLimiter.reportRateLimit();

        const { eventBus } = await import('./EventBus');
        eventBus.emitEvent({
          type: 'UploadFailed',
          jobId: this.jobId,
          sourceId: item.id,
          error: e.message
        });

        retryJob(item);
      }
    } finally {
      clearTimeout(globalTimeoutHandle);
      this.controller = null;
      this.currentFile = null;
      this.currentItem = null;
      this.isBusy = false;
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
        throw new Error(
          `Parent mapping missing in cache for sourceParentId: ${item.sourceParentId} | File: ${item.name}`
        );
      }
    }

    // ─── Step 2: Check checkpoint (resume support) ────────────────────────────
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
        // Unsupported Google Workspace type — skip
        console.log(
          `[Worker ${this.id}] FILE_SKIP | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `Reason: Unsupported Google Workspace MIME: ${item.mimeType}`
        );
        await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'skipped');
        await this.stateManager.commitSuccess(item);
        return;
      }
    }

    // ─── Step 4: Start download stream ────────────────────────────────────────
    console.log(
      `[Worker ${this.id}] DOWNLOAD_START | File: ${item.name} | FileId: ${item.sourceId} | ` +
      `ExportMIME: ${exportMimeType || 'none'}`
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
        `DOWNLOAD_START failed for file "${item.name}" (${item.sourceId}): ${e.message}`
      );
    }

    if (!downloadRes || !downloadRes.data) {
      throw new DownloadError(
        `Failed to obtain download stream for file: ${item.name} (${item.sourceId})`
      );
    }

    console.log(
      `[Worker ${this.id}] DOWNLOAD_STREAM_OBTAINED | File: ${item.name} | FileId: ${item.sourceId}`
    );

    // ─── Step 5: Build progress-tracking PassThrough ──────────────────────────
    // KEY FIX: We create a PassThrough that sits BETWEEN the download stream and
    // the upload. We pipe: downloadStream → progressPT → [upload body]
    // The upload body IS the progressPT stream. This is a single linear pipeline
    // with no circular dependency. We do NOT use Promise.all to race a separate
    // pipeline future against the upload future.
    const progressPT = new PassThrough({
      highWaterMark: this.config.streamBufferSize || 4 * 1024 * 1024
    });

    let bytesSinceLast = 0;
    let lastSpeedTime = Date.now();
    let lastStallCheckBytes = 0;
    this.lastUploadCheckTime = Date.now();

    progressPT.on('data', (chunk: Buffer) => {
      this.lastActivity = Date.now();
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

    // ─── Step 6: Pipe download → progressPT (non-blocking — fires in background)
    // We do NOT await this pipe. The pipe runs as the upload consumes data.
    // If the download errors, progressPT will emit 'error' which is handled above
    // and the upload will see the stream end prematurely → upload will fail cleanly.
    const srcStream = downloadRes.data;
    srcStream.pipe(progressPT);

    // Forward errors from the source stream into progressPT so they propagate
    srcStream.on('error', (err: Error) => {
      console.error(
        `[Worker ${this.id}] DOWNLOAD_STREAM_ERROR | File: ${item.name} | ` +
        `FileId: ${item.sourceId} | Error: ${err.message}`
      );
      progressPT.destroy(err);
    });

    // Forward abort signal into the source stream
    controller.signal.addEventListener('abort', () => {
      srcStream.destroy(new Error('AbortError'));
      progressPT.destroy(new Error('AbortError'));
    }, { once: true });

    // ─── Step 7: Upload stall watchdog ────────────────────────────────────────
    // Watches upload-level bytes (not just download bytes) to detect true stalls
    const uploadStallTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastUploadCheckTime;
      if (elapsed >= UPLOAD_STALL_TIMEOUT_MS) {
        const bytesDelta = this.uploadBytesTracked - lastStallCheckBytes;
        if (bytesDelta === 0) {
          console.error(
            `[Worker ${this.id}] UPLOAD_STALL_DETECTED | File: ${item.name} | ` +
            `FileId: ${item.sourceId} | BytesTransferred: ${this.uploadBytesTracked} | ` +
            `StallDuration: ${elapsed}ms | Aborting.`
          );
          if (controller && !controller.signal.aborted) controller.abort();
        } else {
          // Progress made — reset
          lastStallCheckBytes = this.uploadBytesTracked;
          this.lastUploadCheckTime = now;
        }
      }
    }, 15000);

    // ─── Step 8: Mark as UPLOADING ────────────────────────────────────────────
    await this.stateManager.updateState(item.id, 'UPLOADING');

    console.log(
      `[Worker ${this.id}] UPLOAD_START | File: ${item.name} | FileId: ${item.sourceId} | ` +
      `DestParentId: ${destParentId} | TargetMIME: ${targetMimeType}`
    );

    let uploadedFileId: string;

    try {
      // ─── Step 9: Upload — progressPT is the SOLE upload body ─────────────────
      // KEY FIX: progressPT is the direct upload body. No separate pipeline future.
      // The Google API client reads from progressPT as data arrives from the download.
      // This is a clean linear flow: srcStream → progressPT → Drive API HTTP body.
      const createRes = await this.destDrive.files.create(
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

      if (!createRes.data || !createRes.data.id) {
        throw new UploadError(
          `No file ID returned from Google Drive API for ${item.name} (${item.sourceId})`
        );
      }

      uploadedFileId = createRes.data.id;
      console.log(
        `[Worker ${this.id}] UPLOAD_COMPLETE | File: ${item.name} | FileId: ${item.sourceId} | ` +
        `DestFileId: ${uploadedFileId} | BytesTransferred: ${this.uploadBytesTracked}`
      );
    } finally {
      clearInterval(uploadStallTimer);
      // Destroy streams to release resources regardless of outcome
      if (!progressPT.destroyed) progressPT.destroy();
      if (!srcStream.destroyed) srcStream.destroy();
    }

    // ─── Step 10: Commit checkpoint and mark SUCCESS ───────────────────────────
    console.log(
      `[Worker ${this.id}] VERIFYING | File: ${item.name} | FileId: ${item.sourceId} | ` +
      `DestFileId: ${uploadedFileId}`
    );
    await this.stateManager.updateState(item.id, 'VERIFYING');
    await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'completed');
    await this.stateManager.commitSuccess(item);
    this.rateLimiter.reportSuccess();

    console.log(
      `[Worker ${this.id}] FILE_SUCCESS | File: ${item.name} | FileId: ${item.sourceId} | ` +
      `Size: ${item.size} | UploadedBytes: ${this.uploadBytesTracked}`
    );
  }
}
