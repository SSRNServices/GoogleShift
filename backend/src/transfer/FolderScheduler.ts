import { drive_v3 } from 'googleapis';
import { ManifestStorage, ManifestItem } from '../utils/ManifestStorage';
import { RetryHelper } from '../utils/retry';
import { AdaptiveRateLimiter } from './AdaptiveRateLimiter';
import { FolderDAG, DAGNode } from './FolderDAG';
import { eventBus } from './EventBus';

export class FolderScheduler {
  private destDrive: drive_v3.Drive;
  private jobId: string;
  private options: any;
  private rateLimiter: AdaptiveRateLimiter;
  private dag: FolderDAG;
  
  constructor(jobId: string, rootDestId: string, destDrive: drive_v3.Drive, options: any, rateLimiter: AdaptiveRateLimiter) {
    this.jobId = jobId;
    this.destDrive = destDrive;
    this.options = options;
    this.rateLimiter = rateLimiter;
    this.dag = new FolderDAG(rootDestId);
  }

  public async run() {
    const folders = await ManifestStorage.getPendingFoldersByDepth(this.jobId);
    if (folders.length === 0) return;

    console.log(`[FolderScheduler] Starting creation of ${folders.length} folders using DAG...`);
    
    // Build DAG
    this.dag.build(folders);

    let isComplete = false;
    let failCount = 0;

    while (!this.dag.isComplete()) {
      const activeCount = this.dag.getActiveCount();
      const readyCount = this.dag.getReadyCount();
      
      // If nothing is ready and nothing is active, we are stuck (shouldn't happen unless cyclic or failed parents)
      if (readyCount === 0 && activeCount === 0) {
         console.warn(`[FolderScheduler] Folder DAG is stuck. Remaining nodes are unreachable or failed.`);
         break;
      }

      const availableConcurrency = Math.max(0, this.rateLimiter.getConcurrency() - activeCount);
      
      if (availableConcurrency > 0 && readyCount > 0) {
        const node = this.dag.getNextReady();
        if (node) {
          // Fire and forget, state is tracked inside DAG via activeCount
          this.processNode(node).catch(e => console.error(e));
        }
      } else {
        await new Promise(r => setTimeout(r, 50));
      }
    }
    
    console.log(`[FolderScheduler] Folder creation complete.`);
  }

  private async processNode(node: DAGNode) {
    try {
      const destParentId = this.dag.getDestParentId(node.sourceParentId);
      if (!destParentId) {
        throw new Error(`Critical Error: Destination Parent ID missing for node ${node.name} (Source Parent: ${node.sourceParentId})`);
      }

      let newDestFolderId = destParentId;
      let folderExists = false;

      // Check existing
      if (this.options.skipExisting) {
        await RetryHelper.withRetry('Check Existing Folder', async () => {
            const existing = await this.destDrive.files.list({
                q: `name = '${node.name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${destParentId}' in parents and trashed = false`,
                fields: 'files(id)'
            });
            if (existing.data.files && existing.data.files.length > 0 && existing.data.files[0].id) {
                newDestFolderId = existing.data.files[0].id;
                folderExists = true;
            }
        }, (msg) => console.log(msg), () => this.rateLimiter.reportRateLimit());
        this.rateLimiter.reportSuccess();
      }

      // Create new
      if (!folderExists) {
        await RetryHelper.withRetry('Create Folder', async () => {
            const createRes = await this.destDrive.files.create({
                requestBody: {
                    name: node.name,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [destParentId]
                },
                fields: 'id, name, parents'
            });
            if (!createRes.data.id) {
                throw new Error(`Google Drive API created folder but returned no ID for ${node.name}`);
            }
            newDestFolderId = createRes.data.id;
        }, (msg) => { console.log(msg); }, () => this.rateLimiter.reportRateLimit());
        this.rateLimiter.reportSuccess();
      }

      // Phase 5: Atomic updates
      // Mark as created in DAG which unlocks children
      this.dag.markCreated(node.id, newDestFolderId);
      
      // Emit event to DatabaseWriter
      eventBus.emitEvent({
        type: 'FolderCreated',
        jobId: this.jobId,
        sourceId: node.id,
        destId: newDestFolderId
      });

    } catch (e: any) {
      console.error(`\n[FOLDER ERROR]`);
      console.error(`Folder: ${node.name}`);
      console.error(`Message: ${e.message}`);
      if (e.response) {
         console.error(`Status: ${e.response.status}`);
         console.error(`Data: ${JSON.stringify(e.response.data)}`);
      }
      
      this.dag.markFailed(node.id);
      eventBus.emitEvent({
        type: 'FolderFailed',
        jobId: this.jobId,
        sourceId: node.id,
        error: e.message
      });
    }
  }
}
