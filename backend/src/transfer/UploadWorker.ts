// @ts-nocheck
import { drive_v3 } from 'googleapis';
import { ManifestItem } from '../utils/ManifestStorage';
import { AdaptiveRateLimiter } from './AdaptiveRateLimiter';
import { MigrationStateManager } from '../services/MigrationStateManager';
import { getCheckpoint, saveCheckpoint } from '../utils/database';
import { PassThrough, pipeline } from 'stream';
import { promisify } from 'util';
import { DownloadError, UploadError, VerifyError, StateError } from '../utils/errors';
import { MigrationConfig } from './types';

const streamPipeline = promisify(pipeline);

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

  public async processFile(item: ManifestItem, releaseWorker: (workerId: number) => void, retryJob: (item: ManifestItem) => void) {
    this.isBusy = true;
    this.currentFile = item.name;
    this.currentItem = item;
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    
    console.log(`[Worker ${this.id}] STARTED | Bucket: ${this.affinity} | File: ${item.name} | Size: ${item.size}`);
    
    this.controller = new AbortController();

    try {
      await this.uploadFile(item, this.controller);
    } catch (e: any) {
      if (e.name === 'AbortError' || e.message === 'The operation was aborted' || e.type === 'aborted') {
         console.log(`[Worker ${this.id}] CANCELLED | File: ${item.name} | Reason: Aborted by timeout or cancellation`);
         retryJob(item);
      } else {
         console.error(`[Worker ${this.id}] FAILED | File: ${item.name} | Error: ${e.message}`);
         if (e.response && e.response.status === 429) this.rateLimiter.reportRateLimit();
         
         const { eventBus } = await import('./EventBus');
         eventBus.emitEvent({ type: 'UploadFailed', jobId: this.jobId, sourceId: item.id, error: e.message });
         
         retryJob(item);
      }
    } finally {
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
      destParentId = this.folderCache.get(item.sourceParentId) || this.folderCache.get('root_dest') || this.folderCache.get('root');
      if (!destParentId) throw new Error(`Parent mapping missing in cache for sourceParentId: ${item.sourceParentId}`);
    }

    const cp = await getCheckpoint(this.jobId, 'file', destParentId, item.sourceId);
    if (cp === 'completed' || cp === 'skipped') {
       await this.stateManager.commitSuccess(item);
       return; 
    }

    this.lastActivity = Date.now();
    let targetMimeType = item.mimeType;
    let exportMimeType: string | null = null;

    // Is it a Google Workspace Doc?
    if (item.mimeType.startsWith('application/vnd.google-apps.')) {
      if (item.mimeType === 'application/vnd.google-apps.document') {
        exportMimeType = this.options.transferDocsAsPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        targetMimeType = this.options.transferDocsAsPdf ? 'application/pdf' : item.mimeType;
      } else if (item.mimeType === 'application/vnd.google-apps.spreadsheet') {
        exportMimeType = this.options.transferDocsAsPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        targetMimeType = this.options.transferDocsAsPdf ? 'application/pdf' : item.mimeType;
      } else if (item.mimeType === 'application/vnd.google-apps.presentation') {
        exportMimeType = this.options.transferDocsAsPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        targetMimeType = this.options.transferDocsAsPdf ? 'application/pdf' : item.mimeType;
      }

      if (!exportMimeType) {
        await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'skipped');
        await this.stateManager.commitSuccess(item);
        return;
      }
    }

    // Get source download stream
    let downloadRes: any;
    if (exportMimeType) {
      downloadRes = await this.sourceDrive.files.export({ fileId: item.sourceId, mimeType: exportMimeType }, { responseType: 'stream', signal: controller.signal });
    } else {
      downloadRes = await this.sourceDrive.files.get({ fileId: item.sourceId, alt: 'media' }, { responseType: 'stream', signal: controller.signal });
    }

    if (!downloadRes || !downloadRes.data) {
      throw new DownloadError(`Failed to obtain download stream for file: ${item.name}`);
    }

    // PassThrough stream to bridge download -> upload & track progress
    const pt = new PassThrough({ highWaterMark: this.config.streamBufferSize || 1024 * 1024 });
    let lastTime = Date.now();
    let bytesSinceLast = 0;

    // 30-second activity watchdog interval
    const activityTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > 30000) {
        console.warn(`[Worker ${this.id}] Inactivity timeout (30s) reached on file "${item.name}". Aborting stream.`);
        clearInterval(activityTimer);
        controller.abort();
      }
    }, 5000);

    pt.on('data', (chunk: Buffer) => {
       this.lastActivity = Date.now();
       bytesSinceLast += chunk.length;
       this.stateManager.reportProgressBytes(chunk.length);
       const now = Date.now();
       if (now - lastTime > 1000) {
          const speed = (bytesSinceLast / (now - lastTime)) * 1000;
          this.rateLimiter.reportBandwidth(speed);
          lastTime = now;
          bytesSinceLast = 0;
       }
    });

    await this.stateManager.updateState(item.id, 'UPLOADING');
    let uploadedFileId: string;

    try {
      const pipelinePromise = streamPipeline(downloadRes.data, pt, { signal: controller.signal });

      const createPromise = this.destDrive.files.create({
         requestBody: { name: item.name, parents: [destParentId!], mimeType: targetMimeType },
         media: { body: pt },
         fields: 'id'
      }, { signal: controller.signal });

      const results = await Promise.all([pipelinePromise, createPromise]);
      const createRes = results[1];

      if (!createRes.data || !createRes.data.id) {
         throw new UploadError(`No file ID returned from Google Drive API for ${item.name}`);
      }
      uploadedFileId = createRes.data.id;
    } finally {
      clearInterval(activityTimer);
    }

    // Verification & checkpoint update
    await this.stateManager.updateState(item.id, 'VERIFYING');
    await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'completed');
    await this.stateManager.commitSuccess(item);
    this.rateLimiter.reportSuccess();
    console.log(`[Worker ${this.id}] SUCCESS | File: ${item.name} | Size: ${item.size}`);
  }
}
