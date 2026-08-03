import { FolderScheduler } from '../transfer/FolderScheduler';
import { MigrationStateManager } from './MigrationStateManager';
import { NetworkClient } from '../transfer/NetworkClient';
import { AdaptiveRateLimiter } from '../transfer/AdaptiveRateLimiter';
import { DEFAULT_MIGRATION_CONFIG } from '../transfer/types';
import { updateJobStatus, logJobEvent, updateJobProgress, prisma } from '../utils/database';

export class PreparationService {
  public static async execute(jobId: string, manifestId: string, sessionId: string, options: any, destinationFolder: any, stateManager: MigrationStateManager) {
    const pStart = Date.now();
    console.log(`\n[ENTRY] PreparationService.execute | Job: ${jobId} | Manifest: ${manifestId} | Timestamp: ${pStart}`);
    console.log(`[STATE] PREPARING | Migration: ${jobId} | Reason: Hierarchy setup`);
    
    try {
      await logJobEvent(jobId, `[STATE] PREPARING`);
      await updateJobStatus(jobId, 'PREPARING');
      
      // Send preparation started event
      await updateJobProgress(jobId, { status: 'preparing', currentAction: 'Loading manifest...', event: 'PREPARATION_STARTED' });

      // Reset any previous manifest item statuses for this manifest to PENDING so reruns process afresh
      await prisma.migrationManifest.updateMany({
        where: { jobId: manifestId },
        data: { status: 'PENDING', createdDestId: null }
      });

      if (!destinationFolder || !destinationFolder.id) {
        throw new Error(`Destination folder configuration missing for migration job ${jobId}`);
      }

      const destDrive = await NetworkClient.getDriveClient(sessionId, 'destination');
      const rateLimiter = new AdaptiveRateLimiter(DEFAULT_MIGRATION_CONFIG.workerCount, 2, 20);
      const actualDestId = destinationFolder.id === 'root' ? 'root' : destinationFolder.id;
      
      // Seed root folder
      const { ManifestStorage } = await import('../utils/ManifestStorage');
      await ManifestStorage.updateDestParentId(manifestId, 'root', actualDestId);
      await stateManager.queueChildren('root');

      await updateJobProgress(jobId, { currentAction: 'Creating destination folders...', event: 'PREPARATION_PROGRESS' });
      
      const folderScheduler = new FolderScheduler(jobId, manifestId, actualDestId, destDrive, options, rateLimiter, stateManager);
      await folderScheduler.run();

      // Ensure all pending files in the manifest are queued for transfer
      const unqueuedFiles = await prisma.migrationManifest.updateMany({
        where: { jobId: manifestId, isFolder: false, status: 'PENDING' },
        data: { status: 'QUEUED' }
      });
      if (unqueuedFiles && unqueuedFiles.count > 0) {
        console.log(`[PreparationService] Pre-queued ${unqueuedFiles.count} pending files for file scheduler.`);
      }

      console.log(`[EXIT] PreparationService.execute | Job: ${jobId} | Duration: ${Date.now() - pStart}ms | Status: Success`);
    } catch (error: any) {
      console.error(`[FATAL] PreparationService.execute failed for Job: ${jobId} | Error: ${error.message}`);
      await logJobEvent(jobId, `[STATE] FAILED - Preparation Error: ${error.message}`);
      await updateJobStatus(jobId, 'FAILED');
      throw error;
    }
  }
}
