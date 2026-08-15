import { v4 as uuidv4 } from 'uuid';
import { createJob, updateJobStatus, prisma } from '../utils/database';
import { MigrationRequest, StartMigrationPayload } from '../transfer/types';
import { RequestValidationError, ManifestError } from '../utils/errors';

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

    const manifestId = payload.manifestId || session.manifestId;
    if (!manifestId) {
      throw new ManifestError('Manifest ID missing in request or session.');
    }

    const { ManifestStorage } = await import('../utils/ManifestStorage');
    const manifestExists = await ManifestStorage.hasManifest(manifestId);
    if (!manifestExists) {
      throw new ManifestError(`Manifest with ID ${manifestId} not found.`);
    }

    // ALWAYS generate a brand new unique MigrationJob ID for every run
    const migrationJobId = 'migration_' + Date.now() + '_' + uuidv4().substring(0, 8);

    console.log(`[Backend] Creating new MigrationJob ${migrationJobId} for Manifest ${manifestId} and Session ${sessionId}`);

    const migrationRequest: MigrationRequest = {
      options: payload.options,
      destinationFolder: { id: session.destinationFolderId || 'root', name: 'Destination', mimeType: 'application/vnd.google-apps.folder' },
      sourceSelection: [{ id: session.sourceFolderId || 'root', name: 'Source', mimeType: 'application/vnd.google-apps.folder' }],
      manifestId,
      sessionId
    };

    await createJob(migrationJobId, migrationRequest, userId);

    await updateJobStatus(migrationJobId, 'PREPARING');
    
    const { migrationWorker } = await import('./MigrationWorker');
    
    migrationWorker.executeMigration({
      ...migrationRequest,
      jobId: migrationJobId,
      manifestId,
      status: 'preparing',
      totalFolders: 0,
      totalFiles: 0,
      totalBytes: 0,
      failedFiles: 0,
      lastSuccessfulFile: '',
      sessionId
    }).catch(err => console.error('[FATAL] MigrationWorker execution error:', err));

    return {
      jobId: migrationJobId,
      manifestId,
      status: 'preparing',
      message: 'Migration engine initialized.'
    };
  }
}

export const migrationService = new MigrationService();
