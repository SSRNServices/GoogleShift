import { FolderScheduler } from '../transfer/FolderScheduler';
import { MigrationStateManager } from './MigrationStateManager';
import { NetworkClient } from '../transfer/NetworkClient';
import { AdaptiveRateLimiter } from '../transfer/AdaptiveRateLimiter';
import { DEFAULT_MIGRATION_CONFIG } from '../transfer/types';
import { updateJobStatus, logJobEvent, updateJobProgress, prisma } from '../utils/database';

export class PreparationService {
  public static async execute(
    jobId: string,
    manifestId: string,
    sessionId: string,
    options: any,
    destinationFolder: any,
    stateManager: MigrationStateManager
  ) {
    const pStart = Date.now();
    console.log(
      `\n[MigrationWorker] PREPARATION_START | Job: ${jobId} | Manifest: ${manifestId} | ` +
      `Timestamp: ${new Date().toISOString()}`
    );

    try {
      await logJobEvent(jobId, `[STATE] PREPARING`);
      await updateJobStatus(jobId, 'PREPARING');
      await updateJobProgress(jobId, {
        status: 'preparing',
        currentAction: 'Loading manifest...',
        event: 'PREPARATION_STARTED'
      });

      // ── Determine if this is a fresh start or a resume ───────────────────────
      // On a fresh start: all items are PENDING → reset and re-process folders.
      // On a resume: some items are already SUCCESS/FAILED → do NOT wipe them.
      const alreadyCompletedCount = await prisma.migrationManifest.count({
        where: { jobId: manifestId, status: { in: ['SUCCESS', 'FAILED'] } }
      });
      const isResume = alreadyCompletedCount > 0;

      if (isResume) {
        console.log(
          `[PreparationService] RESUME_DETECTED | JobId: ${jobId} | ` +
          `AlreadyCompleted: ${alreadyCompletedCount} | Skipping full manifest reset.`
        );
        // On resume: only reset items that were stuck mid-flight (not SUCCESS/FAILED)
        const resetCount = await prisma.migrationManifest.updateMany({
          where: {
            jobId: manifestId,
            isFolder: true,
            status: { in: ['QUEUED', 'UPLOADING', 'VERIFYING', 'DOWNLOADING'] }
          },
          data: { status: 'PENDING', createdDestId: null }
        });
        if (resetCount.count > 0) {
          console.log(
            `[PreparationService] RESUME_RESET | Moved ${resetCount.count} stuck folders ` +
            `back to PENDING for re-creation. JobId: ${jobId}`
          );
        }
      } else {
        // Fresh start: reset everything to PENDING
        console.log(
          `[PreparationService] FRESH_START | JobId: ${jobId} | ` +
          `Resetting all manifest items to PENDING.`
        );
        await prisma.migrationManifest.updateMany({
          where: { jobId: manifestId },
          data: { status: 'PENDING', createdDestId: null }
        });
      }

      if (!destinationFolder || !destinationFolder.id) {
        throw new Error(`Destination folder configuration missing for migration job ${jobId}`);
      }

      const destDrive = await NetworkClient.getDriveClient(sessionId, 'destination');
      const rateLimiter = new AdaptiveRateLimiter(DEFAULT_MIGRATION_CONFIG.workerCount, 2, 20);
      const actualDestId = destinationFolder.id === 'root' ? 'root' : destinationFolder.id;

      // Seed root folder mapping
      const { ManifestStorage } = await import('../utils/ManifestStorage');
      await ManifestStorage.updateDestParentId(manifestId, 'root', actualDestId);
      await stateManager.queueChildren('root');

      await updateJobProgress(jobId, {
        currentAction: 'Creating destination folders...',
        event: 'PREPARATION_PROGRESS'
      });

      // Only run FolderScheduler if there are pending folders
      const pendingFolders = await prisma.migrationManifest.count({
        where: { jobId: manifestId, isFolder: true, status: { in: ['PENDING', 'QUEUED'] } }
      });

      if (pendingFolders > 0) {
        console.log(
          `[PreparationService] FOLDER_CREATION_START | PendingFolders: ${pendingFolders} | ` +
          `JobId: ${jobId}`
        );
        const folderScheduler = new FolderScheduler(
          jobId, manifestId, actualDestId, destDrive, options, rateLimiter, stateManager
        );
        await folderScheduler.run();
        console.log(
          `[PreparationService] FOLDER_CREATION_COMPLETE | JobId: ${jobId}`
        );
      } else {
        console.log(
          `[PreparationService] FOLDER_CREATION_SKIP | No pending folders found. ` +
          `(Resume scenario or all folders already created.) JobId: ${jobId}`
        );
      }

      // Ensure all PENDING files are queued for transfer
      const unqueuedFiles = await prisma.migrationManifest.updateMany({
        where: { jobId: manifestId, isFolder: false, status: 'PENDING' },
        data: { status: 'QUEUED' }
      });
      if (unqueuedFiles && unqueuedFiles.count > 0) {
        console.log(
          `[PreparationService] FILES_QUEUED | Count: ${unqueuedFiles.count} | JobId: ${jobId}`
        );
      }

      console.log(
        `[MigrationWorker] PREPARATION_COMPLETE | Job: ${jobId} | ` +
        `Duration: ${Date.now() - pStart}ms`
      );
    } catch (error: any) {
      console.error(
        `[PreparationService] PREPARATION_FAILED | Job: ${jobId} | Error: ${error.message}`
      );
      await logJobEvent(jobId, `[STATE] FAILED - Preparation Error: ${error.message}`);
      await updateJobStatus(jobId, 'FAILED');
      throw error;
    }
  }
}
