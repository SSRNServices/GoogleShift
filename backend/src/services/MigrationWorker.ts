// @ts-nocheck
import { prisma, logJobEvent, updateJobProgress, updateJobStatus } from "../utils/database";
import { NetworkClient } from '../transfer/NetworkClient';
import { FolderScheduler } from '../transfer/FolderScheduler';
import { FileScheduler } from '../transfer/FileScheduler';
import { AdaptiveRateLimiter } from '../transfer/AdaptiveRateLimiter';
import { MigrationStateManager } from '../services/MigrationStateManager';
import { driveService } from '../services/DriveService';
import { DEFAULT_MIGRATION_CONFIG } from '../transfer/types';
import { workerWatchdog } from '../transfer/WorkerWatchdog';

import { MigrationJob } from '../transfer/types';

export class MigrationWorker {
  public async executeMigration(job: MigrationJob) {
    const startTime = Date.now();
    const sourceSelection = job.sourceSelection;
    const destinationFolder = job.destinationFolder;
    const options = job.options;

    const targetManifestId = job.manifestId || job.jobId;
    const stateManager = new MigrationStateManager(job.jobId, targetManifestId);

    console.log(
      `\n${'='.repeat(70)}\n[MigrationWorker] JOB_START | JobId: ${job.jobId} | ` +
      `ManifestId: ${targetManifestId} | SessionId: ${job.sessionId} | ` +
      `Timestamp: ${new Date().toISOString()}\n${'='.repeat(70)}`
    );

    try {
      if (!job.sessionId) {
        throw new Error('Missing session ID for migration job');
      }

      // ── Load Session ──────────────────────────────────────────────────────────
      const session = await prisma.migrationSession.findUnique({
        where: { id: job.sessionId }
      });
      if (!session) {
        throw new Error(`Migration session not found for ID: ${job.sessionId}`);
      }

      const resolvedDestinationFolder = job.destinationFolder || {
        id: session.destinationFolderId || 'root',
        name: 'Destination',
        mimeType: 'application/vnd.google-apps.folder'
      };
      const resolvedSourceSelection = job.sourceSelection || [
        { id: session.sourceFolderId || 'root', name: 'Source', mimeType: 'application/vnd.google-apps.folder' }
      ];

      const userId = session.ownerId;
      const { tokenStore } = await import('../auth/token.store');
      const { googleClientManager } = await import('../auth/google.client');

      const [sourceAccount, destAccount] = await Promise.all([
        tokenStore.getAccount(userId, 'source'),
        tokenStore.getAccount(userId, 'destination')
      ]);

      const wasSourceRefreshFound = !!sourceAccount?.refreshToken;
      const wasDestRefreshFound = !!destAccount?.refreshToken;
      const isSourceExpired = sourceAccount?.expiresAt
        ? sourceAccount.expiresAt.getTime() < Date.now()
        : true;
      const isDestExpired = destAccount?.expiresAt
        ? destAccount.expiresAt.getTime() < Date.now()
        : true;

      console.log(`\n${'='.repeat(67)} AUTH AUDIT`);
      console.log(`Migration ID          : ${job.jobId}`);
      console.log(`User ID               : ${userId}`);
      console.log(`Session ID            : ${job.sessionId}`);
      console.log(`Source Account ID     : ${sourceAccount?.id || 'MISSING'}`);
      console.log(`Destination Account ID: ${destAccount?.id || 'MISSING'}`);
      console.log(`Source Refresh Token  : ${wasSourceRefreshFound ? 'PRESENT' : 'MISSING'}`);
      console.log(`Dest Refresh Token    : ${wasDestRefreshFound ? 'PRESENT' : 'MISSING'}`);
      console.log(`Source Access Expired : ${isSourceExpired}`);
      console.log(`Dest Access Expired   : ${isDestExpired}`);
      console.log(`Worker State          : STARTING`);
      console.log(`${'='.repeat(77)}\n`);

      if (!destAccount) {
        throw new Error(`Account destination not authenticated. Please reconnect destination account.`);
      }
      if (!sourceAccount) {
        throw new Error(`Account source not authenticated. Please reconnect source account.`);
      }

      const sourceClient = await googleClientManager.getAuthenticatedClient(userId, 'source');
      if (!sourceClient) {
        throw new Error(`Source authentication expired or revoked. Please reconnect source account.`);
      }
      const destClient = await googleClientManager.getAuthenticatedClient(userId, 'destination');
      if (!destClient) {
        throw new Error(`Destination authentication expired or revoked. Please reconnect destination account.`);
      }

      // ── Check Manifest ────────────────────────────────────────────────────────
      const totalFiles = await prisma.migrationManifest.count({
        where: { jobId: targetManifestId }
      });
      if (totalFiles === 0) {
        throw new Error(
          'FATAL: Manifest is empty or missing. Please ensure the discovery phase completed before starting migration.'
        );
      }
      console.log(
        `[MigrationWorker] MANIFEST_CHECK | ManifestId: ${targetManifestId} | ` +
        `TotalItems: ${totalFiles} | JobId: ${job.jobId}`
      );

      const { PreparationService } = await import('./PreparationService');
      const { CopyService } = await import('./CopyService');
      const { VerificationService } = await import('./VerificationService');

      // ── Phase 1: PREPARING ────────────────────────────────────────────────────
      console.log(
        `[MigrationWorker] PREPARATION_START | JobId: ${job.jobId} | ` +
        `Timestamp: ${new Date().toISOString()}`
      );
      await logJobEvent(job.jobId, 'Invoking PreparationService');
      await PreparationService.execute(
        job.jobId,
        targetManifestId,
        job.sessionId,
        options,
        resolvedDestinationFolder,
        stateManager
      );
      console.log(
        `[MigrationWorker] PREPARATION_COMPLETE | JobId: ${job.jobId} | ` +
        `Duration: ${Date.now() - startTime}ms`
      );

      // ── Phase 2: COPYING ──────────────────────────────────────────────────────
      console.log(
        `[MigrationWorker] COPY_START | JobId: ${job.jobId} | ` +
        `Timestamp: ${new Date().toISOString()}`
      );
      await logJobEvent(job.jobId, 'Invoking CopyService');
      await CopyService.execute(
        job.jobId,
        targetManifestId,
        job.sessionId,
        options,
        resolvedDestinationFolder,
        stateManager
      );
      console.log(
        `[MigrationWorker] COPY_COMPLETE | JobId: ${job.jobId} | ` +
        `Duration: ${Date.now() - startTime}ms`
      );

      // ── Phase 3: VERIFYING ────────────────────────────────────────────────────
      console.log(
        `[MigrationWorker] VERIFY_START | JobId: ${job.jobId} | ` +
        `Timestamp: ${new Date().toISOString()}`
      );
      await logJobEvent(job.jobId, 'Invoking VerificationService');
      await VerificationService.execute(job.jobId, targetManifestId);
      console.log(
        `[MigrationWorker] VERIFY_COMPLETE | JobId: ${job.jobId} | ` +
        `Duration: ${Date.now() - startTime}ms`
      );

      // ── Completion ────────────────────────────────────────────────────────────
      const finalStatus = 'completed';
      console.log(
        `\n[MigrationWorker] JOB_COMPLETE | JobId: ${job.jobId} | ` +
        `Duration: ${Date.now() - startTime}ms | Status: ${finalStatus} | ` +
        `Timestamp: ${new Date().toISOString()}`
      );
      await logJobEvent(job.jobId, `[STATE] COMPLETED`);
      await updateJobStatus(job.jobId, 'COMPLETED');
      await updateJobProgress(job.jobId, { status: finalStatus, networkStatus: 'online' });

      // Isolated post-completion telemetry (non-critical)
      try {
        const summaryStats = await stateManager.getSummaryStats(targetManifestId);
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
        console.warn(
          `[MigrationWorker] Post-completion summary update warning for ${job.jobId}: ${postErr.message}`
        );
      }

      console.log(
        `[MigrationWorker] WORKER_EXIT | JobId: ${job.jobId} | ` +
        `TotalDuration: ${Date.now() - startTime}ms`
      );
    } catch (e: any) {
      // Stop progress interval on error
      try { stateManager.stopProgressInterval(); } catch (_) {}

      // Terminal State Protection
      const currentJob = await prisma.migrationJob.findUnique({ where: { id: job.jobId } });
      if (currentJob?.state === 'COMPLETED') {
        console.warn(
          `[MigrationWorker] WORKER_CRASH_SUPPRESSED | Intercepted non-fatal post-completion ` +
          `error for ${job.jobId}: ${e.message}`
        );
        return;
      }

      const errorPayload = {
        name: e.name || 'WorkerError',
        message: e.message,
        stack: e.stack,
        jobId: job.jobId
      };
      const serializedError = JSON.stringify(errorPayload);

      console.error(
        `\n[MigrationWorker] WORKER_CRASH | JobId: ${job.jobId} | ` +
        `Duration: ${Date.now() - startTime}ms | Error: ${serializedError}`
      );
      await logJobEvent(job.jobId, `[STATE] FAILED - ${serializedError}`, 'error');
      await updateJobProgress(job.jobId, { networkStatus: 'online' });
      await updateJobStatus(job.jobId, 'FAILED');
    }
  }
}

export const migrationWorker = new MigrationWorker();
