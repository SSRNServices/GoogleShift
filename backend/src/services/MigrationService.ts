import { createJob, updateJobStatus, getDb } from '../utils/database';
import { MigrationRequest } from '../transfer/types';
import { RequestValidationError, ManifestError, ShortcutResolutionError } from '../utils/errors';
import { driveService } from './DriveService';

export class MigrationService {
  public async startMigrationJob(payload: MigrationRequest) {
    // 1. Validate the payload structure
    if (!payload.sourceSelection || !Array.isArray(payload.sourceSelection) || payload.sourceSelection.length === 0) {
      throw new RequestValidationError('Missing source selection');
    }
    if (!payload.destinationFolder || !payload.destinationFolder.id) {
      throw new RequestValidationError('Missing destination folder');
    }
    if (!payload.options) {
      throw new RequestValidationError('Missing transfer options');
    }
    if (!payload.manifestId) {
      throw new RequestValidationError('Missing manifest ID');
    }

    const jobId = payload.manifestId;

    // 2. Validate Manifest
    const db = await getDb();
    const manifestStats = await db.get(`SELECT count(*) as count FROM migration_manifest WHERE jobId = ?`, [jobId]);
    if (!manifestStats || manifestStats.count === 0) {
      throw new ManifestError('Manifest validation failed: No items found for this manifest. Please rescan.');
    }

    // 3. Google Shortcut Support
    for (let i = 0; i < payload.sourceSelection.length; i++) {
      const item = payload.sourceSelection[i];
      if (item.mimeType === 'application/vnd.google-apps.shortcut') {
        // Only resolve if we have shortcut details or if we can fetch it (but DriveService mapping only has shortcutDetails if we added it, wait...)
        // Actually, if we just fetch info using the shortcut's ID, does it return the shortcut or target?
        // Let's assume frontend provides `shortcutDetails` or we fetch it.
        const targetId = item.shortcutDetails?.targetId;
        if (!targetId) {
            throw new ShortcutResolutionError(`Shortcut ${item.id} has no targetId`);
        }
        
        console.log(`[SHORTCUT] Shortcut detected | Original ID: ${item.id} | Target ID: ${targetId}`);
        try {
            const realFolder = await driveService.getFolderInfo('source', targetId);
            payload.sourceSelection[i] = {
               ...realFolder,
               parentId: item.parentId // preserve the tree structural mount point
            };
            console.log(`[SHORTCUT] Target Name: ${realFolder.name}`);
        } catch (e: any) {
            throw new ShortcutResolutionError(`Failed to resolve shortcut ${item.id} to target ${targetId}: ${e.message}`);
        }
      }
    }

    console.log(`[Backend] Creating migration job ${jobId}`);

    // Write to DB
    await createJob(jobId, payload);
    
    // The route `POST /start` handles explicit worker initialization, but we can do it right here since the route calls this service method.
    // However, since we return the job right away to the frontend to redirect it, we will async dispatch the worker.
    await updateJobStatus(jobId, 'STARTING');
    
    const { migrationWorker } = await import('./MigrationWorker');
    
    // Explicit background dispatch (No double serialization anymore since the worker accepts the raw object)
    migrationWorker.executeMigration({
      ...payload,
      jobId,
      status: 'starting',
      totalFolders: 0,
      totalFiles: 0,
      totalBytes: 0,
      failedFiles: 0,
      lastSuccessfulFile: ''
    }).catch(err => console.error('[FATAL]', err));

    return {
      jobId,
      status: 'starting',
      message: 'Migration engine initialized.'
    };
  }
}

export const migrationService = new MigrationService();
