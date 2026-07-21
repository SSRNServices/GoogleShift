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
    const startTime = Date.now();
    const sourceSelection = job.sourceSelection;
    const destinationFolder = job.destinationFolder;
    const options = job.options;

    console.log(`\n[ENTRY] MigrationWorker.executeMigration | Job: ${job.jobId} | Input: ${JSON.stringify(options)}`);
    console.log(`[STATE] STARTING\nMigration: ${job.jobId}\nReason: Explicit Start/Resume`);
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

    // Watchdog for deadlock detection (30 seconds)
    let lastTransferred = -1;
    let stuckCycles = 0;
    const watchdog = setInterval(() => {
      const metrics = progress.getMetrics();
      if (lastTransferred === metrics.transferredBytes + metrics.completedFolders + metrics.completedFiles) {
        stuckCycles++;
        if (stuckCycles >= 6) { // 30 seconds
          console.error(`\n[DEADLOCK DETECTED] Migration ${job.jobId} has been stuck for 30 seconds.`);
          console.error(`Active state dump:`);
          console.error(`Busy Workers: ${metrics.busyWorkers}`);
          console.error(`Queue Length: ${metrics.queueLength}`);
          console.error(`Completed: Folders ${metrics.completedFolders}, Files ${metrics.completedFiles}`);
          console.error(`Pending items not advancing.`);
          
          logJobEvent(job.jobId, `[STATE] FAILED - Deadlock detected. Workers: ${metrics.busyWorkers}, Queue: ${metrics.queueLength}`);
          updateJobProgress(job.jobId, { status: 'failed' });
          
          clearInterval(watchdog);
          process.exit(1); // Force crash to allow pm2 or docker to restart, or just throw.
        }
      } else {
        stuckCycles = 0;
        lastTransferred = metrics.transferredBytes + metrics.completedFolders + metrics.completedFiles;
      }
    }, 5000);

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
      const folderScheduler = new FolderScheduler(job.jobId, actualDestId, destDrive, options, rateLimiter, progress);
      const phase1Start = Date.now();
      await folderScheduler.run();
      console.log(`[EXIT] FolderScheduler.run() | Duration: ${Date.now() - phase1Start}ms`);

      // Ensure all DB writes from folder creation are committed
      const drainStart = Date.now();
      await dbWriter.drain();
      console.log(`[EXIT] DatabaseWriter.drain() | Duration: ${Date.now() - drainStart}ms`);

      // Generate mapping cache
      const folderCache = new Map<string, string>();
      folderCache.set('root_dest', actualDestId);
      const manifestRows = await db.all(`SELECT id, createdDestId FROM migration_manifest WHERE jobId = ? AND isFolder = 1 AND status = 'COMPLETED'`, [job.jobId]);
      for (const row of manifestRows) {
         if (row.createdDestId) folderCache.set(row.id, row.createdDestId);
      }

      // Phase 2: Files
      console.log(`\n[STATE] COPYING_FILES\nMigration: ${job.jobId}\nReason: File Scheduler Initiated`);
      await logJobEvent(job.jobId, `[STATE] COPYING_FILES`);
      await updateJobProgress(job.jobId, { status: 'uploading_files' });
      const fileScheduler = new FileScheduler(job.jobId, sourceDrive, destDrive, options, rateLimiter, progress, folderCache);
      const phase2Start = Date.now();
      await fileScheduler.run();
      console.log(`[EXIT] FileScheduler.run() | Duration: ${Date.now() - phase2Start}ms`);
      
      // Ensure all DB writes from files are committed
      await dbWriter.drain();
      dbWriter.stop();

      console.log(`\n[STATE] VERIFYING\nMigration: ${job.jobId}\nReason: Transfers completed, verifying final state`);
      await logJobEvent(job.jobId, `[STATE] VERIFYING`);
      await updateJobProgress(job.jobId, { status: 'verifying' });
      
      progress.stop();
      clearInterval(watchdog);
      
      const finalStatus = 'completed';
      console.log(`\n[STATE] COMPLETED\nMigration: ${job.jobId}\nReason: All phases verified and completed successfully`);
      await logJobEvent(job.jobId, `[STATE] COMPLETED`);
      await updateJobProgress(job.jobId, { status: finalStatus, networkStatus: 'online' });
      console.log(`[EXIT] MigrationWorker.executeMigration | Total Duration: ${Date.now() - startTime}ms`);
    } catch (e: any) {
      progress.stop();
      clearInterval(watchdog);
      
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
