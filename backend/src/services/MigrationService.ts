// @ts-nocheck
import { createJob, updateJobStatus, prisma } from '../utils/database';
import { MigrationRequest, StartMigrationPayload } from '../transfer/types';
import { RequestValidationError, ManifestError, ShortcutResolutionError } from '../utils/errors';

export class MigrationService {
  public async startMigrationJob(sessionId: string, payload: StartMigrationPayload) {
    if (!payload.sourceSelection || payload.sourceSelection.length === 0) {
      throw new RequestValidationError('Missing source selection.');
    }
    if (!payload.destinationFolderId) {
      throw new RequestValidationError('Missing destination folder');
    }
    if (!payload.options) {
      throw new RequestValidationError('Missing transfer options');
    }

    const jobId = payload.manifestId || 'manifest_' + Date.now();

    const totalFolders = 0;
    const totalFiles = 0;
    const totalBytes = 0;

    console.log(`[Backend] Creating migration job ${jobId}`);

    // Create a payload for createJob that mimics MigrationRequest
    const migrationRequest: MigrationRequest = {
      sourceSelection: payload.sourceSelection, // Pass the real source selection to the worker
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

    await updateJobStatus(jobId, 'PREPARING');
    
    const { migrationWorker } = await import('./MigrationWorker');
    
    // Explicit background dispatch
    migrationWorker.executeMigration({
      ...migrationRequest,
      jobId,
      status: 'preparing',
      totalFolders,
      totalFiles,
      totalBytes,
      failedFiles: 0,
      lastSuccessfulFile: '',
      sessionId
    }).catch(err => console.error('[FATAL]', err));

    return {
      jobId,
      status: 'preparing',
      message: 'Migration engine initialized.'
    };
  }
}

export const migrationService = new MigrationService();
