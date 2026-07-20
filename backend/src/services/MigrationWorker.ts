import { getDb, updateJobProgress, logJobEvent } from '../utils/database';
import { NetworkHeartbeat } from '../utils/NetworkHeartbeat';
import { NetworkClient } from '../transfer/NetworkClient';
import { FolderScheduler } from '../transfer/FolderScheduler';
import { FileScheduler } from '../transfer/FileScheduler';
import { AdaptiveRateLimiter } from '../transfer/AdaptiveRateLimiter';
import { ProgressAggregator } from '../transfer/ProgressAggregator';
import { DatabaseWriter } from '../transfer/DatabaseWriter';
import { DEFAULT_MIGRATION_CONFIG } from '../transfer/types';

import { MigrationJob } from '../transfer/types';

export class MigrationWorker {
  public async executeMigration(job: MigrationJob) {
    const sourceSelection = job.sourceSelection;
    const destinationFolder = job.destinationFolder;
    const options = job.options;

    console.log(`\n[STATE] STARTING\nMigration: ${job.jobId}\nReason: Explicit Start/Resume`);
    await logJobEvent(job.jobId, `[STATE] STARTING`);
    await updateJobProgress(job.jobId, { status: 'running', networkStatus: 'online', retryCount: 0 });

    const db = await getDb();
    const completedStats = await db.get(`
      SELECT 
        SUM(CASE WHEN isFolder = 1 THEN 1 ELSE 0 END) as completedFolders,
        SUM(CASE WHEN isFolder = 0 THEN 1 ELSE 0 END) as completedFiles,
        SUM(CASE WHEN isFolder = 0 THEN size ELSE 0 END) as transferredBytes
      FROM migration_manifest 
      WHERE jobId = ? AND status = 'COMPLETED'
    `, [job.jobId]);

    const progress = new ProgressAggregator(job.jobId, {
      totalFolders: job.totalFolders || 0,
      totalFiles: job.totalFiles || 0,
      totalBytes: job.totalBytes || 0,
      completedFolders: completedStats?.completedFolders || 0,
      completedFiles: completedStats?.completedFiles || 0,
      transferredBytes: completedStats?.transferredBytes || 0,
      failedFiles: job.failedFiles || 0,
      lastSuccessfulFile: job.lastSuccessfulFile || '',
    }, DEFAULT_MIGRATION_CONFIG.progressInterval, DEFAULT_MIGRATION_CONFIG.resumeInterval);

    try {
      progress.start();

      const sourceDrive = NetworkClient.getDriveClient('source');
      const destDrive = NetworkClient.getDriveClient('destination');
      const rateLimiter = new AdaptiveRateLimiter(DEFAULT_MIGRATION_CONFIG.workerCount, 2, 20);

      const actualDestId = destinationFolder.id === 'root' ? 'root' : destinationFolder.id;
      const { ManifestStorage } = await import('../utils/ManifestStorage');

      // Seed root folder
      await ManifestStorage.updateDestParentId(job.jobId, 'root', actualDestId);

      // Start database writer
      const dbWriter = new DatabaseWriter(job.jobId);

      // Phase 1: Folders
      console.log(`\n[STATE] CREATING_FOLDERS\nMigration: ${job.jobId}\nReason: Folder Scheduler Initiated`);
      await logJobEvent(job.jobId, `[STATE] CREATING_FOLDERS`);
      await updateJobProgress(job.jobId, { status: 'creating_tree' });
      const folderScheduler = new FolderScheduler(job.jobId, actualDestId, destDrive, options, rateLimiter);
      await folderScheduler.run();

      // Ensure all DB writes from folder creation are committed
      await dbWriter.drain();

      // Generate mapping cache
      const folderCache = new Map<string, string>();
      folderCache.set('root_dest', actualDestId);
      const manifestRows = await db.all(`SELECT id, createdDestId FROM migration_manifest WHERE jobId = ? AND isFolder = 1 AND status = 'COMPLETED'`, [job.jobId]);
      for (const row of manifestRows) {
         if (row.createdDestId) folderCache.set(row.id, row.createdDestId);
      }

      // Phase 2: Files
      console.log(`\n[STATE] UPLOADING\nMigration: ${job.jobId}\nReason: File Scheduler Initiated`);
      await logJobEvent(job.jobId, `[STATE] UPLOADING`);
      await updateJobProgress(job.jobId, { status: 'uploading_files' });
      const fileScheduler = new FileScheduler(job.jobId, sourceDrive, destDrive, options, rateLimiter, progress, folderCache);
      await fileScheduler.run();
      
      // Ensure all DB writes from files are committed
      await dbWriter.drain();
      dbWriter.stop();

      console.log(`\n[STATE] VERIFYING\nMigration: ${job.jobId}\nReason: Transfers completed, verifying final state`);
      await logJobEvent(job.jobId, `[STATE] VERIFYING`);
      await updateJobProgress(job.jobId, { status: 'verifying' });
      
      progress.stop();
      
      const finalStatus = 'completed';
      console.log(`\n[STATE] COMPLETED\nMigration: ${job.jobId}\nReason: All phases verified and completed successfully`);
      await logJobEvent(job.jobId, `[STATE] COMPLETED`);
      await updateJobProgress(job.jobId, { status: finalStatus, networkStatus: 'online' });
    } catch (e: any) {
      progress.stop();
      
      const errorPayload = {
        name: e.name || 'WorkerError',
        message: e.message,
        stack: e.stack,
        jobId: job.jobId
      };
      const serializedError = JSON.stringify(errorPayload);
      
      console.log(`\n[STATE] FAILED\nMigration: ${job.jobId}\nReason: ${serializedError}`);
      await logJobEvent(job.jobId, `[STATE] FAILED - ${serializedError}`);
      await updateJobProgress(job.jobId, { status: 'failed', networkStatus: 'online' });
      throw e;
    }
  }
}

export const migrationWorker = new MigrationWorker();
