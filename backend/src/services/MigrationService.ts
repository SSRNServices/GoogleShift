// @ts-nocheck
import { createJob, updateJobStatus, prisma } from '../utils/database';
import { MigrationRequest, StartMigrationPayload } from '../transfer/types';
import { RequestValidationError, ManifestError, ShortcutResolutionError } from '../utils/errors';

export class MigrationService {
  public async startMigrationJob(userId: string, sessionId: string, payload: StartMigrationPayload) {
    const session = await prisma.migrationSession.findUnique({
      where: { id: sessionId, ownerId: userId }
    });

    if (!session) {
      throw new RequestValidationError('Migration session not found.');
    }
    
    if (!session.sourceFolderId) {
      throw new RequestValidationError('Missing source selection in session.');
    }
    
    if (!session.destinationFolderId) {
      throw new RequestValidationError('Missing destination folder in session.');
    }
    
    if (!payload.options) {
      throw new RequestValidationError('Missing transfer options in payload.');
    }

    const jobId = payload.manifestId || 'manifest_' + Date.now();

    const totalFolders = 0;
    const totalFiles = 0;
    const totalBytes = 0;

    console.log(`[Backend] Creating migration job ${jobId} for session ${sessionId}`);

    // Create a payload for createJob that mimics MigrationRequest
    const migrationRequest: MigrationRequest = {
      sourceSelection: [{ id: session.sourceFolderId, name: 'Source', mimeType: 'application/vnd.google-apps.folder' }],
      destinationFolder: { id: session.destinationFolderId, name: 'Destination', mimeType: 'application/vnd.google-apps.folder' },
      options: payload.options,
      manifestId: jobId,
      sessionId
    };

    // We will just pass it along
    await createJob(jobId, migrationRequest, userId); // Use actual userId

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
