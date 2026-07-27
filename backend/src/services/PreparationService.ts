import { FolderScheduler } from '../transfer/FolderScheduler';
import { MigrationStateManager } from './MigrationStateManager';
import { NetworkClient } from '../transfer/NetworkClient';
import { AdaptiveRateLimiter } from '../transfer/AdaptiveRateLimiter';
import { DEFAULT_MIGRATION_CONFIG } from '../transfer/types';
import { updateJobStatus, logJobEvent, updateJobProgress, prisma } from '../utils/database';

export class PreparationService {
  public static async execute(jobId: string, sessionId: string, options: any, destinationFolder: any, stateManager: MigrationStateManager) {
    console.log(`\n[STATE] PREPARING\nMigration: ${jobId}\nReason: Hierarchy setup`);
    await logJobEvent(jobId, `[STATE] PREPARING`);
    await updateJobStatus(jobId, 'PREPARING');
    
    // Send preparation started event
    await updateJobProgress(jobId, { status: 'preparing', currentAction: 'Loading manifest...', event: 'PREPARATION_STARTED' });

    const destDrive = await NetworkClient.getDriveClient(sessionId, 'destination');
    const rateLimiter = new AdaptiveRateLimiter(DEFAULT_MIGRATION_CONFIG.workerCount, 2, 20);
    const actualDestId = destinationFolder.id === 'root' ? 'root' : destinationFolder.id;
    
    // Seed root folder
    const { ManifestStorage } = await import('../utils/ManifestStorage');
    await ManifestStorage.updateDestParentId(jobId, 'root', actualDestId);
    await stateManager.queueChildren('root');

    await updateJobProgress(jobId, { currentAction: 'Creating destination folders...', event: 'PREPARATION_PROGRESS' });
    
    const folderScheduler = new FolderScheduler(jobId, actualDestId, destDrive, options, rateLimiter, stateManager);
    await folderScheduler.run();

    console.log(`[PreparationService] Folder creation complete`);
  }
}
