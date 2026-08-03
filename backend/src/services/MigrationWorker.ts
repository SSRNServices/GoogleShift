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

      // Load Session and verify ownership & credentials
      const session = await prisma.migrationSession.findUnique({
        where: { id: job.sessionId }
      });

      if (!session) {
        throw new Error(`Migration session not found for ID: ${job.sessionId}`);
      }

      const userId = session.ownerId;
      const { tokenStore } = await import('../auth/token.store');
      const { googleClientManager } = await import('../auth/google.client');

      const [sourceAccount, destAccount] = await Promise.all([
        tokenStore.getAccount(userId, 'source'),
        tokenStore.getAccount(userId, 'destination')
      ]);

      const wasSourceRefreshFound = !!sourceAccount?.refreshToken;
      const wasDestRefreshFound = !!destAccount?.refreshToken;
      const isSourceExpired = sourceAccount?.expiresAt ? sourceAccount.expiresAt.getTime() < Date.now() : true;
      const isDestExpired = destAccount?.expiresAt ? destAccount.expiresAt.getTime() < Date.now() : true;

      console.log(`\n=================== WORKER AUTHENTICATION AUDIT ===================`);
      console.log(`Migration ID          : ${job.jobId}`);
      console.log(`User ID               : ${userId}`);
      console.log(`Session ID            : ${job.sessionId}`);
      console.log(`Source Account ID     : ${sourceAccount?.id || 'MISSING'}`);
      console.log(`Destination Account ID: ${destAccount?.id || 'MISSING'}`);
      console.log(`Source Refresh Token  : ${wasSourceRefreshFound ? 'PRESENT' : 'MISSING'}`);
      console.log(`Dest Refresh Token    : ${wasDestRefreshFound ? 'PRESENT' : 'MISSING'}`);
      console.log(`Source Access Expired : ${isSourceExpired}`);
      console.log(`Dest Access Expired   : ${isDestExpired}`);
      console.log(`Auth Provider Used    : DatabaseTokenStore / GoogleClientManager`);
      console.log(`Worker State          : STARTING`);
      console.log(`===================================================================\n`);

      if (!destAccount) {
        throw new Error(`Account destination not authenticated. Please reconnect destination account.`);
      }

      if (!sourceAccount) {
        throw new Error(`Account source not authenticated. Please reconnect source account.`);
      }

      // Proactively test loading authenticated clients (which auto-refreshes if needed)
      const sourceClient = await googleClientManager.getAuthenticatedClient(userId, 'source');
      if (!sourceClient) {
        throw new Error(`Source authentication expired or revoked. Please reconnect source account.`);
      }

      const destClient = await googleClientManager.getAuthenticatedClient(userId, 'destination');
      if (!destClient) {
        throw new Error(`Destination authentication expired or revoked. Please reconnect destination account.`);
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
      
      // Isolated Post-Completion Telemetry & Reporting (Non-critical)
      try {
        const summaryStats = await stateManager.getSummaryStats();
        await prisma.migrationJob.update({
           where: { id: job.jobId },
           data: {
              completedAt: new Date(),
              completedFiles: summaryStats.completedFiles,
              failedFiles: summaryStats.failedFiles,
              transferredBytes: summaryStats.transferredBytes
           }
        });
      } catch (postErr: any) {
        console.warn(`[MigrationWorker] Post-completion summary update warning for ${job.jobId}: ${postErr.message}`);
      }
      
      console.log(`[EXIT] MigrationWorker.executeMigration | Total Duration: ${Date.now() - startTime}ms`);
    } catch (e: any) {
      // Terminal State Protection: Once COMPLETED, no subsequent error can degrade status to FAILED
      const currentJob = await prisma.migrationJob.findUnique({ where: { id: job.jobId } });
      if (currentJob?.state === 'COMPLETED') {
         console.warn(`[MigrationWorker] Intercepted non-fatal post-completion error for ${job.jobId}: ${e.message}`);
         return;
      }

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
