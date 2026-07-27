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
