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
      destParentId = this.folderCache.get(item.sourceParentId === 'root' ? 'root_dest' : item.sourceParentId);
      if (!destParentId) throw new Error('Parent mapping missing in cache');
    }

    const cp = await getCheckpoint(this.jobId, 'file', destParentId, item.sourceId);
    if (cp === 'completed' || cp === 'skipped') {
       await this.stateManager.commitSuccess(item);
       return; 
    }

    this.lastActivity = Date.now();
    let targetMimeType = item.mimeType;
    let exportMimeType: string | null = null;
    let downloadRes: any;

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

      if (exportMimeType) {
        downloadRes = await this.sourceDrive.files.export({ fileId: item.sourceId, mimeType: exportMimeType }, { responseType: 'stream', signal: controller.signal });
      } else {
        await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'skipped');
        await this.stateManager.commitSuccess(item);
        return;
      }
    } else {
      downloadRes = await this.sourceDrive.files.get({ fileId: item.sourceId, alt: 'media' }, { responseType: 'stream', signal: controller.signal });
    }

    // Wrap download stream to track bytes
    const pt = new PassThrough({ highWaterMark: this.config.streamBufferSize });
    let lastTime = Date.now();
    let bytesSinceLast = 0;
    
    pt.on('data', (chunk: Buffer) => {
       this.lastActivity = Date.now();
       bytesSinceLast += chunk.length;
       const now = Date.now();
       if (now - lastTime > 1000) {
          const speed = (bytesSinceLast / (now - lastTime)) * 1000;
          this.rateLimiter.reportBandwidth(speed);
          lastTime = now;
          bytesSinceLast = 0;
       }
    });

    // We do NOT await pipeline here immediately, we await it inside the upload to run concurrently.
    const pipelinePromise = streamPipeline(downloadRes.data, pt, { signal: controller.signal });

    await this.stateManager.updateState(item.id, 'UPLOADING');
    let uploadedFileId: string;

    // Resumable Upload (fetch) for >20MB files
    const MB = 1024 * 1024;
    const isLarge = item.size !== undefined && item.size > 20 * MB;

    if (isLarge && !exportMimeType) {
       // Direct Fetch Resumable
       const authContext = (this.destDrive as any).context._options.auth;
       const accessToken = (await authContext.getAccessToken()).token;
       
       const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
          method: 'POST',
          headers: {
             'Authorization': `Bearer ${accessToken}`,
             'Content-Type': 'application/json',
             'X-Upload-Content-Type': targetMimeType
          },
          body: JSON.stringify({ name: item.name, parents: [destParentId!], mimeType: targetMimeType }),
          signal: controller.signal
       });
       
       if (!initRes.ok) throw new UploadError(`Failed to initialize resumable session: ${initRes.status}`);
       const location = initRes.headers.get('location');
       if (!location) throw new UploadError(`No location header in resumable init`);

       const uploadRes = await fetch(location, {
          method: 'PUT',
          headers: { 'Content-Length': item.size.toString() },
          body: pt as any, // Node 18 fetch supports Readable/PassThrough via standard streams but might need duplex:'half'
          duplex: 'half',
          signal: controller.signal
       } as any);

       if (!uploadRes.ok) throw new UploadError(`Upload failed with status: ${uploadRes.status}`);
       const data = await uploadRes.json();
       uploadedFileId = data.id;
    } else {
       // Standard googleapis for small files and docs exports
       const createRes = await this.destDrive.files.create({
          requestBody: { name: item.name, parents: [destParentId!], mimeType: targetMimeType },
          media: { body: pt },
          fields: 'id'
       }, { signal: controller.signal, timeout: 24 * 60 * 60 * 1000 });
       
       if (!createRes.data.id) throw new UploadError('No ID returned from create');
       uploadedFileId = createRes.data.id;
    }

    // Ensure pipeline succeeds
    await pipelinePromise;

    // Asynchronous Verification
    await this.stateManager.updateState(item.id, 'VERIFYING');
    
    (async () => {
       try {
         const verifyRes = await this.destDrive.files.get({ fileId: uploadedFileId, fields: 'id' });
         if (verifyRes.data.id) {
            await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'completed');
            await this.stateManager.commitSuccess(item);
         } else {
            throw new VerifyError('ID not found in verify fetch');
         }
       } catch (e: any) {
         console.error(`[Worker ${this.id}] Async validation failed for ${item.name}: ${e.message}`);
         try {
           await this.stateManager.updateState(item.id, 'FAILED');
         } catch(err) {
           console.error(`[Worker ${this.id}] Failed to mark as FAILED:`, err);
         }
       }
    })();

    this.rateLimiter.reportSuccess();
  }
}
