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

    console.log(`\n[ENTRY] MigrationWorker.executeMigration | Job: ${job.jobId}`);
    await logJobEvent(job.jobId, `[STATE] STARTING - Initializing worker`);
    await updateJobStatus(job.jobId, 'QUEUED');

    const stateManager = new MigrationStateManager(job.jobId);

    try {
      if (!job.sessionId) {
        throw new Error('Missing session ID for migration job');
      }

      // Check Manifest
      const totalFiles = await prisma.migrationManifest.count({
        where: { jobId: job.jobId }
      });
      if (totalFiles === 0) {
        throw new Error('FATAL: Manifest is empty or missing. Please ensure the discovery phase completed before starting migration.');
      }
      
      const { PreparationService } = await import('./PreparationService');
      const { CopyService } = await import('./CopyService');
      const { VerificationService } = await import('./VerificationService');

      // Phase 1: PREPARING
      await logJobEvent(job.jobId, 'Invoking PreparationService');
      await PreparationService.execute(job.jobId, job.sessionId, options, destinationFolder, stateManager);

      // Phase 2: COPYING
      await logJobEvent(job.jobId, 'Invoking CopyService');
      await CopyService.execute(job.jobId, job.sessionId, options, destinationFolder, stateManager);

      // Phase 3: VERIFYING
      await logJobEvent(job.jobId, 'Invoking VerificationService');
      await VerificationService.execute(job.jobId);
      
      const finalStatus = 'completed';
      console.log(`\n[STATE] COMPLETED\nMigration: ${job.jobId}\nReason: All phases verified and completed successfully`);
      await logJobEvent(job.jobId, `[STATE] COMPLETED`);
      await updateJobStatus(job.jobId, 'COMPLETED');
      await updateJobProgress(job.jobId, { status: finalStatus, networkStatus: 'online' });
      
      const summaryStats = await stateManager.getStats();
      await prisma.migrationJob.update({
         where: { id: job.jobId },
         data: {
            completedAt: new Date(),
            completedFiles: summaryStats.completedFiles,
            failedFiles: summaryStats.failedFiles,
            transferredBytes: summaryStats.transferredBytes
         }
      });
      
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
      await logJobEvent(job.jobId, `[STATE] FAILED - ${serializedError}`, 'error');
      await updateJobProgress(job.jobId, { networkStatus: 'online' });
      await updateJobStatus(job.jobId, 'FAILED');
    }
  }
}

export const migrationWorker = new MigrationWorker();
