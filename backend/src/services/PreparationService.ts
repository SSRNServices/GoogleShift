import { FolderScheduler } from '../transfer/FolderScheduler';
import { MigrationStateManager } from './MigrationStateManager';
import { NetworkClient } from '../transfer/NetworkClient';
import { AdaptiveRateLimiter } from '../transfer/AdaptiveRateLimiter';
import { DEFAULT_MIGRATION_CONFIG } from '../transfer/types';
import { updateJobStatus, logJobEvent, updateJobProgress, prisma } from '../utils/database';

export class PreparationService {
  public static async execute(jobId: string, manifestId: string, sessionId: string, options: any, destinationFolder: any, stateManager: MigrationStateManager) {
    console.log(`\n[STATE] PREPARING\nMigration: ${jobId} | Manifest: ${manifestId}\nReason: Hierarchy setup`);
    await logJobEvent(jobId, `[STATE] PREPARING`);
    await updateJobStatus(jobId, 'PREPARING');
    
    // Send preparation started event
    await updateJobProgress(jobId, { status: 'preparing', currentAction: 'Loading manifest...', event: 'PREPARATION_STARTED' });

    // Reset any previous manifest item statuses for this manifest to PENDING so reruns process afresh
    await prisma.migrationManifest.updateMany({
      where: { jobId: manifestId },
      data: { status: 'PENDING', createdDestId: null }
    });

    const destDrive = await NetworkClient.getDriveClient(sessionId, 'destination');
    const rateLimiter = new AdaptiveRateLimiter(DEFAULT_MIGRATION_CONFIG.workerCount, 2, 20);
    const actualDestId = destinationFolder.id === 'root' ? 'root' : destinationFolder.id;
    
    // Seed root folder
    const { ManifestStorage } = await import('../utils/ManifestStorage');
    await ManifestStorage.updateDestParentId(manifestId, 'root', actualDestId);
    await stateManager.queueChildren('root');

    await updateJobProgress(jobId, { currentAction: 'Creating destination folders...', event: 'PREPARATION_PROGRESS' });
    
    const folderScheduler = new FolderScheduler(manifestId, actualDestId, destDrive, options, rateLimiter, stateManager);
    await folderScheduler.run();

    // Ensure all pending files in the manifest are queued for transfer
    const unqueuedFiles = await prisma.migrationManifest.updateMany({
      where: { jobId: manifestId, isFolder: false, status: 'PENDING' },
      data: { status: 'QUEUED' }
    });
    if (unqueuedFiles && unqueuedFiles.count > 0) {
      console.log(`[PreparationService] Pre-queued ${unqueuedFiles.count} pending files for file scheduler.`);
    }

    console.log(`[PreparationService] Folder creation & preparation complete.`);
  }
}
