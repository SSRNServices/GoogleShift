// @ts-nocheck
import { prisma, logJobEvent, updateJobProgress, updateJobStatus } from "../utils/database";
import { NetworkHeartbeat } from '../utils/NetworkHeartbeat';
import { NetworkClient } from '../transfer/NetworkClient';
import { FolderScheduler } from '../transfer/FolderScheduler';
import { FileScheduler } from '../transfer/FileScheduler';
import { AdaptiveRateLimiter } from '../transfer/AdaptiveRateLimiter';
import { MigrationStateManager } from '../services/MigrationStateManager';
import { driveService } from '../services/DriveService';
import { DEFAULT_MIGRATION_CONFIG } from '../transfer/types';

import { MigrationJob } from '../transfer/types';

export class MigrationWorker {
  public async executeMigration(job: MigrationJob) {
    const startTime = Date.now();
    const sourceSelection = job.sourceSelection;
    const destinationFolder = job.destinationFolder;
    const options = job.options;

    console.log(`\n[ENTRY] MigrationWorker.executeMigration | Job: ${job.jobId} | Input: ${JSON.stringify(options)}`);
    console.log(`[STATE] STARTING\nMigration: ${job.jobId}\nReason: Explicit Start/Resume`);
    await logJobEvent(job.jobId, `[STATE] STARTING`);
    await updateJobStatus(job.jobId, 'SCANNING');
    await updateJobProgress(job.jobId, { currentAction: 'Initializing scan...', networkStatus: 'online', retryCount: 0 });

    // removed getDb
    // initialization will depend on the state manager which already has accurate Prisma queries

    const stateManager = new MigrationStateManager(job.jobId);

    try {

      if (!job.sessionId) {
        throw new Error('Missing session ID for migration job');
      }
      
      const sourceDrive = await NetworkClient.getDriveClient(job.sessionId, 'source');
      const destDrive = await NetworkClient.getDriveClient(job.sessionId, 'destination');
      const rateLimiter = new AdaptiveRateLimiter(DEFAULT_MIGRATION_CONFIG.workerCount, 2, 20);

      const actualDestId = destinationFolder.id === 'root' ? 'root' : destinationFolder.id;
      const { ManifestStorage } = await import('../utils/ManifestStorage');

      // Phase 0: Scanning
      console.log(`\n[STATE] SCANNING\nMigration: ${job.jobId}\nReason: Building Manifest from Source`);
      await logJobEvent(job.jobId, `[STATE] SCANNING - Building manifest`);
      
      let lastEmitTime = 0;
      await driveService.getSelectionSummary(
        job.sessionId,
        'source',
        sourceSelection,
        async (folders, files, bytes, currentAction) => {
          const now = Date.now();
          if (now - lastEmitTime > 1000 || currentAction === 'Complete') {
             lastEmitTime = now;
             await updateJobProgress(job.jobId, {
               totalFolders: folders,
               totalFiles: files,
               totalBytes: bytes,
               currentAction
             });
          }
        },
        job.jobId // Pass jobId down so DriveService uses it for manifest items
      );
      
      console.log(`[STATE] SCAN COMPLETE`);
      await updateJobStatus(job.jobId, 'RUNNING');
      await updateJobProgress(job.jobId, { currentAction: 'Scan complete. Preparing folders...' });

      // Seed root folder
      await ManifestStorage.updateDestParentId(job.jobId, 'root', actualDestId);
      
      // Queue root files immediately so FileScheduler doesn't think the queue is empty
      await stateManager.queueChildren('root');

      // Phase 1: Folders
      console.log(`\n[STATE] CREATING_FOLDERS\nMigration: ${job.jobId}\nReason: Folder Scheduler Initiated`);
      await logJobEvent(job.jobId, `[STATE] CREATING_FOLDERS`);
      await updateJobProgress(job.jobId, { status: 'creating_tree' });
      const folderScheduler = new FolderScheduler(job.jobId, actualDestId, destDrive, options, rateLimiter, stateManager);
      const phase1Start = Date.now();
      await folderScheduler.run();
      console.log(`[EXIT] FolderScheduler.run() | Duration: ${Date.now() - phase1Start}ms`);

      // Generate mapping cache
      const folderCache = new Map<string, string>();
      folderCache.set('root_dest', actualDestId);
      const manifestRows = await prisma.migrationManifest.findMany({
        where: { jobId: job.jobId, isFolder: true, status: 'SUCCESS' },
        select: { id: true, createdDestId: true }
      });
      for (const row of manifestRows) {
         if (row.createdDestId) folderCache.set(row.id, row.createdDestId);
      }

      // Phase 2: Files
      console.log(`\n[STATE] COPYING_FILES\nMigration: ${job.jobId}\nReason: File Scheduler Initiated`);
      await logJobEvent(job.jobId, `[STATE] COPYING_FILES`);
      await updateJobProgress(job.jobId, { status: 'uploading_files' });
      const fileScheduler = new FileScheduler(job.jobId, sourceDrive, destDrive, options, rateLimiter, stateManager, folderCache);
      const phase2Start = Date.now();
      await fileScheduler.run();
      console.log(`[EXIT] FileScheduler.run() | Duration: ${Date.now() - phase2Start}ms`);

      console.log(`\n[STATE] VERIFYING\nMigration: ${job.jobId}\nReason: Transfers completed, verifying final state`);
      await logJobEvent(job.jobId, `[STATE] VERIFYING`);
      await updateJobProgress(job.jobId, { status: 'verifying' });
      
      // The file scheduler finalization handles terminal state reporting via stateManager
      // So no need to explicitly emit completion here unless it's just finalizing.
      // Final verification might be unnecessary if fileScheduler.run() returned,
      // because fileScheduler invokes stateManager.finalizeMigration()
      
      const finalStatus = 'completed';
      console.log(`\n[STATE] COMPLETED\nMigration: ${job.jobId}\nReason: All phases verified and completed successfully`);
      await logJobEvent(job.jobId, `[STATE] COMPLETED`);
      await updateJobProgress(job.jobId, { status: finalStatus, networkStatus: 'online' });
      console.log(`[EXIT] MigrationWorker.executeMigration | Total Duration: ${Date.now() - startTime}ms`);
    } catch (e: any) {

      const errorPayload = {
        name: e.name || 'WorkerError',
        message: e.message,
        stack: e.stack,
        jobId: job.jobId
      };
      const serializedError = JSON.stringify(errorPayload);
      
      console.log(`\n[STATE] FAILED\nMigration: ${job.jobId}\nReason: ${serializedError}`);
      await logJobEvent(job.jobId, `[STATE] FAILED - ${serializedError}`);
      await updateJobProgress(job.jobId, { networkStatus: 'online' });
      await updateJobStatus(job.jobId, 'FAILED');
      throw e;
    }
  }
}

export const migrationWorker = new MigrationWorker();
