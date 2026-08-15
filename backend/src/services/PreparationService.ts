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
      const { ManifestStorage } = await import('../utils/ManifestStorage');
      const alreadyCompletedCount = await ManifestStorage.countItems(manifestId, {
        statusIn: ['SUCCESS', 'FAILED']
      });
      const isResume = alreadyCompletedCount > 0;

      if (isResume) {
        console.log(
          `[PreparationService] RESUME_DETECTED | JobId: ${jobId} | ` +
          `AlreadyCompleted: ${alreadyCompletedCount} | Skipping full manifest reset.`
        );
        // On resume: only reset items that were stuck mid-flight (not SUCCESS/FAILED)
        const resetCount = await ManifestStorage.updateManyStatus(
          manifestId,
          { isFolder: true, statusIn: ['QUEUED', 'UPLOADING', 'VERIFYING', 'DOWNLOADING'] },
          'PENDING',
          true
        );
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
        await ManifestStorage.resetAllStatus(manifestId, 'PENDING');
      }

      if (!destinationFolder || !destinationFolder.id) {
        throw new Error(`Destination folder configuration missing for migration job ${jobId}`);
      }

      const destDrive = await NetworkClient.getDriveClient(sessionId, 'destination');
      const rateLimiter = new AdaptiveRateLimiter(DEFAULT_MIGRATION_CONFIG.workerCount, 2, 20);
      const actualDestId = destinationFolder.id === 'root' ? 'root' : destinationFolder.id;

      // Seed root folder mapping
      await ManifestStorage.updateDestParentId(manifestId, 'root', actualDestId);
      await stateManager.queueChildren('root');

      await updateJobProgress(jobId, {
        currentAction: 'Creating destination folders...',
        event: 'PREPARATION_PROGRESS'
      });

      // Only run FolderScheduler if there are pending folders
      const pendingFolders = await ManifestStorage.countItems(manifestId, {
        isFolder: true,
        statusIn: ['PENDING', 'QUEUED']
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
      const unqueuedFiles = await ManifestStorage.updateManyStatus(
        manifestId,
        { isFolder: false, statusIn: ['PENDING'] },
        'QUEUED'
      );
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
