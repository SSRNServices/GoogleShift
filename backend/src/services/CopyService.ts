import { FileScheduler } from '../transfer/FileScheduler';
import { MigrationStateManager } from './MigrationStateManager';
import { NetworkClient } from '../transfer/NetworkClient';
import { AdaptiveRateLimiter } from '../transfer/AdaptiveRateLimiter';
import { DEFAULT_MIGRATION_CONFIG } from '../transfer/types';
import { updateJobStatus, logJobEvent, updateJobProgress } from '../utils/database';
import { prisma } from '../utils/database';

export class CopyService {
  public static async execute(
    jobId: string,
    manifestId: string,
    sessionId: string,
    options: any,
    destinationFolder: any,
    stateManager: MigrationStateManager
  ) {
    console.log(
      `\n[STATE] COPY_START | JobId: ${jobId} | ManifestId: ${manifestId} | ` +
      `Timestamp: ${new Date().toISOString()}`
    );
    await logJobEvent(jobId, `[STATE] COPYING`);
    await updateJobStatus(jobId, 'COPYING');
    await updateJobProgress(jobId, {
      status: 'copying',
      currentAction: 'Starting file transfers...',
      event: 'COPY_STARTED'
    });

    // ── Recover any items left stuck in UPLOADING/VERIFYING from a previous run ──
    console.log(`[CopyService] RECOVERY_CHECK | JobId: ${jobId}`);
    await stateManager.recoverStalledItems();

    const sourceDrive = await NetworkClient.getDriveClient(sessionId, 'source');
    const destDrive = await NetworkClient.getDriveClient(sessionId, 'destination');
    const rateLimiter = new AdaptiveRateLimiter(DEFAULT_MIGRATION_CONFIG.workerCount, 2, 20);

    // ── Build folder cache ────────────────────────────────────────────────────────
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
    console.log(
      `[CopyService] FOLDER_CACHE | Size: ${folderCache.size} | JobId: ${jobId}`
    );

    const existingJob = await prisma.migrationJob.findUnique({ where: { id: jobId } });
    console.log(
      `[CopyService] PREFLIGHT | JobExists: ${!!existingJob} | JobId: ${jobId} | ` +
      `ManifestId: ${manifestId}`
    );
    if (!existingJob) {
      throw new Error(
        `MigrationJob ${jobId} does not exist in database before starting FileScheduler.`
      );
    }

    const fileScheduler = new FileScheduler(
      jobId,
      manifestId,
      sourceDrive,
      destDrive,
      options,
      rateLimiter,
      stateManager,
      folderCache
    );

    console.log(`[CopyService] SCHEDULER_START | JobId: ${jobId}`);
    await fileScheduler.run();
    console.log(`[CopyService] COPY_COMPLETE | JobId: ${jobId} | Timestamp: ${new Date().toISOString()}`);
  }
}
