import { FileScheduler } from '../transfer/FileScheduler';
import { MigrationStateManager } from './MigrationStateManager';
import { NetworkClient } from '../transfer/NetworkClient';
import { AdaptiveRateLimiter } from '../transfer/AdaptiveRateLimiter';
import { DEFAULT_MIGRATION_CONFIG } from '../transfer/types';
import { updateJobStatus, logJobEvent, updateJobProgress } from '../utils/database';
import { prisma } from '../utils/database';

export class CopyService {
  public static async execute(jobId: string, manifestId: string, sessionId: string, options: any, destinationFolder: any, stateManager: MigrationStateManager) {
    console.log(`\n[STATE] COPYING\nMigration: ${jobId} | Manifest: ${manifestId}\nReason: File transfer setup`);
    await logJobEvent(jobId, `[STATE] COPYING`);
    await updateJobStatus(jobId, 'COPYING');
    await updateJobProgress(jobId, { status: 'copying', currentAction: 'Starting file transfers...', event: 'COPY_STARTED' });

    const sourceDrive = await NetworkClient.getDriveClient(sessionId, 'source');
    const destDrive = await NetworkClient.getDriveClient(sessionId, 'destination');
    const rateLimiter = new AdaptiveRateLimiter(DEFAULT_MIGRATION_CONFIG.workerCount, 2, 20);

    // Generate mapping cache
    const actualDestId = destinationFolder.id === 'root' ? 'root' : destinationFolder.id;
    const folderCache = new Map<string, string>();
    folderCache.set('root_dest', actualDestId);
    folderCache.set('root', actualDestId);

    const manifestRows = await prisma.migrationManifest.findMany({
      where: { jobId: manifestId, isFolder: true },
      select: { id: true, createdDestId: true }
    });
    for (const row of manifestRows) {
      if (row.createdDestId) {
         folderCache.set(row.id, row.createdDestId);
      }
    }
    console.log(`[CopyService] Folder cache built with ${folderCache.size} mappings.`);

    const fileScheduler = new FileScheduler(
      manifestId, 
      sourceDrive, 
      destDrive, 
      options, 
      rateLimiter, 
      stateManager,
      folderCache
    );

    console.log(`[CopyService] Executing FileScheduler...`);
    await fileScheduler.run();
    console.log(`[CopyService] File copy phase complete.`);
  }
}
