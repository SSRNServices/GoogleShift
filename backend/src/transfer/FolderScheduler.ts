// @ts-nocheck
import { drive_v3 } from 'googleapis';
import { ManifestStorage, ManifestItem } from '../utils/ManifestStorage';
import { RetryHelper } from '../utils/retry';
import { AdaptiveRateLimiter } from './AdaptiveRateLimiter';
import { FolderDAG, DAGNode } from './FolderDAG';
import { eventBus } from './EventBus';
import { MigrationStateManager } from '../services/MigrationStateManager';

export class FolderScheduler {
  private destDrive: drive_v3.Drive;
  private jobId: string;
  private manifestId: string;
  private options: any;
  private rateLimiter: AdaptiveRateLimiter;
  private dag: FolderDAG;
  private stateManager: MigrationStateManager;
  
  constructor(jobId: string, manifestId: string, rootDestId: string, destDrive: drive_v3.Drive, options: any, rateLimiter: AdaptiveRateLimiter, stateManager: MigrationStateManager) {
    this.jobId = jobId;
    this.manifestId = manifestId;
    this.destDrive = destDrive;
    this.options = options;
    this.rateLimiter = rateLimiter;
    this.dag = new FolderDAG(rootDestId);
    this.stateManager = stateManager;
  }

  public async run() {
    console.log(`\n[ENTRY] FolderScheduler.run() for Job ${this.jobId} and Manifest ${this.manifestId}`);
    const runStart = Date.now();
    const folders = await ManifestStorage.getPendingFoldersByDepth(this.manifestId);
    if (folders.length === 0) {
       console.log(`[EXIT] FolderScheduler.run() | 0 folders found`);
       return;
    }

    console.log(`[FolderScheduler] Starting creation of ${folders.length} folders using DAG...`);
    
    // Build DAG
    console.log(`[FolderScheduler] Building DAG`);
    this.dag.build(folders);
    
    const diag = this.dag.getDiagnostics();
    console.log(`[FolderScheduler] DAG Built | Nodes: ${diag.nodes} | Edges: ${diag.edges} | Root Nodes: ${diag.rootNodes} | Ready Queue: ${diag.readyQueueSize}`);

    if (diag.rootNodes === 0 || diag.readyQueueSize === 0) {
       console.error(`[FATAL] DAG Construction Failed. Root Nodes: ${diag.rootNodes} | Ready Queue: ${diag.readyQueueSize}`);
       this.dag.dumpDAG();
       throw new Error(`DAG Construction Failed: No root nodes or ready nodes found. Deadlock prevents start.`);
    }

    let lastDiagTime = Date.now();
    let lastProgressTime = Date.now();
    let prevReady = -1;
    let prevActive = -1;

    while (!this.dag.isComplete()) {
      const activeCount = this.dag.getActiveCount();
      const readyCount = this.dag.getReadyCount();
      
      const now = Date.now();
      
      // 10-second Diagnostic Dump (prevents stdout log flooding & event loop starvation)
      if (now - lastDiagTime >= 10000) {
        const concurrency = this.rateLimiter.getConcurrency();
        console.log(`[Scheduler Status] Workers Running: ${activeCount} | Workers Idle: ${concurrency - activeCount} | Ready Queue: ${readyCount}`);
        lastDiagTime = now;
      }

      // 15-second Deadlock / Stall Detector
      if (readyCount !== prevReady || activeCount !== prevActive) {
         lastProgressTime = now;
         prevReady = readyCount;
         prevActive = activeCount;
      }
      if (now - lastProgressTime >= 15000) {
         console.warn(`[FolderScheduler] 15s stall detected. Triggering MigrationReconciler...`);
         const { MigrationReconciler } = await import('../services/MigrationReconciler');
         await MigrationReconciler.reconcileSchedulerState(this.manifestId, this.destDrive, this.dag.getDestParentId('root') || 'root');

         const pendingFolders = await ManifestStorage.getPendingFoldersByDepth(this.manifestId);
         if (pendingFolders.length === 0) {
            console.log(`[FolderScheduler] Reconciliation complete: No pending folders remain in DB. Exiting cleanly.`);
            break;
         }

         this.dag.rebuildFromDB(pendingFolders);
         lastProgressTime = now;
      }

      // If nothing is ready and nothing is active, run final DB reconciliation
      if (readyCount === 0 && activeCount === 0) {
         console.log(`[FolderScheduler] Queue & workers idle. Running final DB reconciliation...`);
         const { MigrationReconciler } = await import('../services/MigrationReconciler');
         await MigrationReconciler.reconcileSchedulerState(this.manifestId, this.destDrive, this.dag.getDestParentId('root') || 'root');

         const remainingFolders = await ManifestStorage.getPendingFoldersByDepth(this.manifestId);
         if (remainingFolders.length === 0) {
            console.log(`[FolderScheduler] All folders successfully created or reconciled.`);
            break;
         } else {
            console.warn(`[FolderScheduler] ${remainingFolders.length} folders still pending after reconciliation. Rebuilding DAG...`);
            this.dag.rebuildFromDB(remainingFolders);
            if (this.dag.getReadyCount() === 0 && this.dag.getActiveCount() === 0) {
               console.error(`[FolderScheduler] Unable to advance DAG for ${remainingFolders.length} unresolved folders.`);
               this.dag.dumpDAG();
               break;
            }
         }
      }

      const availableConcurrency = Math.max(0, this.rateLimiter.getConcurrency() - activeCount);
      
      if (availableConcurrency > 0 && readyCount > 0) {
        const node = this.dag.getNextReady();
        if (node) {
          // Fire and forget, state is tracked inside DAG via activeCount
          this.processNode(node).catch(e => {
             console.error(`[Unhandled Promise Rejection] in processNode: ${e.message}`);
          });
        }
      } else {
        await new Promise(r => setTimeout(r, 50));
      }
    }
    
    console.log(`[FolderScheduler] Folder creation complete.`);
    console.log(`[EXIT] FolderScheduler.run() | Duration: ${Date.now() - runStart}ms`);
  }

  private async processNode(node: DAGNode) {
    try {
      this.stateManager.activeFolderName = node.name;
      const destParentId = this.dag.getDestParentId(node.sourceParentId);
      if (!destParentId) {
        throw new Error(`Critical Error: Destination Parent ID missing for node ${node.name} (Source Parent: ${node.sourceParentId})`);
      }

      let newDestFolderId = destParentId;
      let folderExists = false;

      // Check existing
      if (this.options.skipExisting) {
        const cachedDestId = this.dag.getDestParentId(node.id);
        if (cachedDestId) {
          newDestFolderId = cachedDestId;
          folderExists = true;
        } else {
          await RetryHelper.withRetry('Check Existing Folder', async () => {
              const existing = await this.destDrive.files.list({
                  q: `name = '${node.name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${destParentId}' in parents and trashed = false`,
                  fields: 'files(id)'
              }, { timeout: 30000 });
              if (existing.data.files && existing.data.files.length > 0 && existing.data.files[0].id) {
                  newDestFolderId = existing.data.files[0].id;
                  folderExists = true;
              }
          }, (msg) => {}, () => this.rateLimiter.reportRateLimit());
          this.rateLimiter.reportSuccess();
        }
      }

      // Create new
      if (!folderExists) {
        let activeDestParentId = destParentId;
        await RetryHelper.withRetry('Create Folder', async () => {
          try {
            const createRes = await this.destDrive.files.create({
              requestBody: {
                name: node.name,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [activeDestParentId]
              },
              fields: 'id, name, parents'
            }, { timeout: 30000 });
            if (!createRes.data.id) {
              throw new Error(`Google Drive API created folder but returned no ID for ${node.name}`);
            }
            newDestFolderId = createRes.data.id;
          } catch (createErr: any) {
            const { GoogleDriveErrorClassifier } = await import('../utils/GoogleDriveErrorClassifier');
            const { destinationShardManager } = await import('./DestinationShardManager');
            const classified = GoogleDriveErrorClassifier.classify(createErr, {
              operation: 'files.createFolder',
              sourceFolderId: node.id,
              destinationFolderId: activeDestParentId
            });

            if (classified.classification === 'DESTINATION_FOLDER_CHILD_LIMIT') {
              console.warn(
                `[FolderScheduler] Parent folder ${activeDestParentId} full when creating "${node.name}". ` +
                `Creating destination shard...`
              );
              const shard = await destinationShardManager.getOrCreateShard(
                this.jobId,
                this.manifestId,
                this.destDrive,
                {
                  sourceFolderId: node.sourceParentId,
                  sourceFolderName: node.name,
                  originalDestinationFolderId: activeDestParentId,
                  parentDestinationFolderId: 'root'
                }
              );
              activeDestParentId = shard.shardDestinationFolderId;
              const retryRes = await this.destDrive.files.create({
                requestBody: {
                  name: node.name,
                  mimeType: 'application/vnd.google-apps.folder',
                  parents: [activeDestParentId]
                },
                fields: 'id, name, parents'
              }, { timeout: 30000 });
              if (!retryRes.data.id) {
                throw new Error(`Google Drive API created folder in shard but returned no ID for ${node.name}`);
              }
              newDestFolderId = retryRes.data.id;
            } else {
              throw createErr;
            }
          }
        }, (msg) => {}, () => this.rateLimiter.reportRateLimit());
        this.rateLimiter.reportSuccess();
      }

      // Phase 5: Atomic updates
      await this.stateManager.commitFolderSuccess(node.id, newDestFolderId);

      // Mark as created in DAG which unlocks children folders
      this.dag.markCreated(node.id, newDestFolderId);

      // Queue child files in the database
      await this.stateManager.queueChildren(node.id);

    } catch (e: any) {
      console.error(`\n[FOLDER ERROR] Folder: ${node.name} | Message: ${e.message}`);
      if (e.response) {
         console.error(`Status: ${e.response.status} | Data: ${JSON.stringify(e.response.data)}`);
      }
      
      this.dag.markFailed(node.id);
      await this.stateManager.commitFolderError(node.id);
    }
  }
}
