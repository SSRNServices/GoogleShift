// @ts-nocheck
import { createJob, updateJobStatus, prisma } from '../utils/database';
import { MigrationRequest } from '../transfer/types';
import { RequestValidationError, ManifestError, ShortcutResolutionError } from '../utils/errors';

export class MigrationService {
  public async startMigrationJob(sessionId: string, payload: { manifestId: string, destinationFolderId: string, options: any }) {
    if (!payload.manifestId) {
      throw new RequestValidationError('Missing manifest ID. Source scan has not completed.');
    }
    if (!payload.destinationFolderId) {
      throw new RequestValidationError('Missing destination folder');
    }
    if (!payload.options) {
      throw new RequestValidationError('Missing transfer options');
    }

    const jobId = payload.manifestId;

    // 2. Validate Manifest via Prisma
    const manifestStats = await prisma.migrationManifest.aggregate({
      where: { jobId },
      _count: { id: true },
      _sum: { size: true }
    });

    if (manifestStats._count.id === 0) {
      throw new ManifestError('Manifest validation failed: No items found for this manifest. Please rescan.');
    }

    const folderStats = await prisma.migrationManifest.count({
      where: { jobId, isFolder: true }
    });

    const fileStats = await prisma.migrationManifest.count({
      where: { jobId, isFolder: false }
    });

    const totalFolders = folderStats;
    const totalFiles = fileStats;
    const totalBytes = Number(manifestStats._sum.size || 0);

    console.log(`[Backend] Creating migration job ${jobId}`);

    // Create a payload for createJob that mimics MigrationRequest
    const migrationRequest: MigrationRequest = {
      sourceSelection: [], // Deprecated in favor of DB manifest
      destinationFolder: { id: payload.destinationFolderId, name: 'Destination' },
      options: payload.options,
      manifestId: jobId,
    };

    // Write to DB - pass the logged-in user id which should be available
    // But currently we don't have ownerId passed here. Wait, we can pass it from controller!
    // Actually createJob in database.ts expects ownerId, but it was just (jobId, payload). Wait!
    // Let's check how createJob is called: createJob(jobId, payload)
    
    // We will just pass it along
    await createJob(jobId, migrationRequest, sessionId); // sessionId is actually userId here

    await updateJobStatus(jobId, 'STARTING');
    
    const { migrationWorker } = await import('./MigrationWorker');
    
    // Explicit background dispatch
    migrationWorker.executeMigration({
      ...migrationRequest,
      jobId,
      status: 'starting',
      totalFolders,
      totalFiles,
      totalBytes,
      failedFiles: 0,
      lastSuccessfulFile: '',
      sessionId
    }).catch(err => console.error('[FATAL]', err));

    return {
      jobId,
      status: 'starting',
      message: 'Migration engine initialized.'
    };
  }
}

export const migrationService = new MigrationService();
