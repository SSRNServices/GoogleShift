import { drive_v3 } from 'googleapis';
import { ManifestStorage, ManifestItem } from '../utils/ManifestStorage';
import { RetryHelper } from '../utils/retry';
import { AdaptiveRateLimiter } from './AdaptiveRateLimiter';
import { ProgressAggregator } from './ProgressAggregator';
import { getDb, saveCheckpoint, getCheckpoint } from '../utils/database';

export class UploadWorker {
  private id: number;
  private sourceDrive: drive_v3.Drive;
  private destDrive: drive_v3.Drive;
  private rateLimiter: AdaptiveRateLimiter;
  private progress: ProgressAggregator;
  private jobId: string;
  private options: any;
  private isBusy: boolean = false;
  private folderCache: Map<string, string>;

  constructor(id: number, jobId: string, sourceDrive: drive_v3.Drive, destDrive: drive_v3.Drive, rateLimiter: AdaptiveRateLimiter, progress: ProgressAggregator, options: any, folderCache: Map<string, string>) {
    this.id = id;
    this.jobId = jobId;
    this.sourceDrive = sourceDrive;
    this.destDrive = destDrive;
    this.rateLimiter = rateLimiter;
    this.progress = progress;
    this.options = options;
    this.folderCache = folderCache;
  }

  public get isIdle() { return !this.isBusy; }

  public async processFile(item: ManifestItem) {
    this.isBusy = true;
    try {
      await this.uploadFile(item);
    } catch (e: any) {
      console.error(`\n[UPLOAD ERROR] Worker: ${this.id}`);
      console.error(`File: ${item.name} (${item.sourceId})`);
      console.error(`Message: ${e.message}`);
      if (e.response) {
        console.error(`Status: ${e.response.status}`);
        console.error(`Headers: ${JSON.stringify(e.response.headers)}`);
        console.error(`Data: ${JSON.stringify(e.response.data)}`);
      }
      console.error(`Stack: ${e.stack}\n`);
      
      const { eventBus } = await import('./EventBus');
      eventBus.emitEvent({ type: 'UploadFailed', jobId: this.jobId, sourceId: item.id, error: e.message });
      
      this.progress.reportFileFailed();
    } finally {
      this.isBusy = false;
    }
  }

  private async uploadFile(item: ManifestItem) {
    let destParentId = item.destParentId;
    
    if (!destParentId) {
      if (item.sourceParentId === 'root') {
         destParentId = this.folderCache.get('root_dest');
      } else {
         destParentId = this.folderCache.get(item.sourceParentId);
      }
      
      if (!destParentId) {
         console.log(`[Worker ${this.id}] Skipped file ${item.name} because parent mapping is missing in cache.`);
         const { eventBus } = await import('./EventBus');
         eventBus.emitEvent({ type: 'UploadFailed', jobId: this.jobId, sourceId: item.id, error: 'Parent mapping missing in cache' });
         this.progress.reportFileFailed();
         return;
      }
    }

    // Checkpoint check
    const cp = await getCheckpoint(this.jobId, 'file', destParentId, item.sourceId);
    if (cp === 'completed' || cp === 'skipped') {
       console.log(`[Worker ${this.id}] Resumed past completed file: ${item.name}`);
       const { eventBus } = await import('./EventBus');
       eventBus.emitEvent({ type: 'UploadFinished', jobId: this.jobId, sourceId: item.id, bytes: item.size });
       return; // Already accounted for in progress totals on boot
    }

    console.log(`[FILE_STARTED] Worker: ${this.id} | File: ${item.name} | Source ID: ${item.sourceId} | Destination Parent: ${destParentId}`);

    await RetryHelper.withRetry(`Upload ${item.name}`, async () => {
      let mediaBody: any;
      let targetMimeType = item.mimeType;
      let exportMimeType: string | null = null;

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
          console.log(`[FILE_PROGRESS] Download Started (Export) for ${item.name}`);
          const res = await this.sourceDrive.files.export({ fileId: item.sourceId, mimeType: exportMimeType }, { responseType: 'stream' });
          mediaBody = res.data;
          console.log(`[FILE_PROGRESS] Download Finished (Export) for ${item.name}`);
        } else {
          console.log(`[Worker ${this.id}] Skipped unsupported file type: ${item.name}`);
          await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'skipped');
          return;
        }
      } else {
        console.log(`[FILE_PROGRESS] Download Started for ${item.name}`);
        const res = await this.sourceDrive.files.get({ fileId: item.sourceId, alt: 'media' }, { responseType: 'stream' });
        mediaBody = res.data;
        console.log(`[FILE_PROGRESS] Download Finished for ${item.name}`);
      }

      if (this.options.skipExisting) {
        const existingRes = await this.destDrive.files.list({
          q: `name = '${item.name.replace(/'/g, "\\'")}' and '${destParentId}' in parents and trashed = false`,
          fields: 'files(id)'
        });
        if (existingRes.data.files && existingRes.data.files.length > 0) {
          console.log(`[Worker ${this.id}] Skipped existing file: ${item.name}`);
          await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'skipped');
          return;
        }
      }

      console.log(`[FILE_PROGRESS] Uploading:\nFile name: ${item.name}\nSource ID: ${item.sourceId}\nDestination folder ID: ${destParentId}\nMime type: ${targetMimeType}\nSize: ${item.size}`);
      
      const createRes = await this.destDrive.files.create({
        requestBody: {
          name: item.name,
          parents: [destParentId!],
          mimeType: targetMimeType
        },
        media: {
          body: mediaBody
        },
        fields: 'id, parents, name, mimeType'
      });

      console.log(`[FILE_PROGRESS] Google Response for ${item.name}:\nID: ${createRes.data.id}\nParents: ${createRes.data.parents?.join(',')}\nName: ${createRes.data.name}\nMimeType: ${createRes.data.mimeType}`);

      if (!createRes.data.id) {
         throw new Error(`Google Drive API returned success but no file ID was provided in the response.`);
      }

      // End-to-End validation check
      console.log(`[FILE_PROGRESS] Validating ${item.name} existence in Drive...`);
      const verifyRes = await this.destDrive.files.get({
        fileId: createRes.data.id,
        fields: 'id'
      });
      
      if (!verifyRes.data.id) {
         throw new Error(`Google Drive API created file, but validation fetch failed to find it.`);
      }

      console.log(`[FILE_FINISHED] Google Upload Completed | Destination File ID: ${createRes.data.id}`);
      
      await saveCheckpoint(this.jobId, 'file', destParentId!, item.sourceId, 'completed');
    }, (msg) => { console.log(msg); }, () => this.rateLimiter.reportRateLimit());

    this.rateLimiter.reportSuccess();
    
    const { eventBus } = await import('./EventBus');
    eventBus.emitEvent({ type: 'UploadFinished', jobId: this.jobId, sourceId: item.id, bytes: item.size });
    this.progress.reportFileCompleted(item.size, item.name);
    
    console.log(`[FILE_PROGRESS] Database Write Queued | Progress Updated | Worker Released`);
  }
}
