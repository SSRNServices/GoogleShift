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

    const manifestTotals = await db.get(`
      SELECT 
        SUM(CASE WHEN isFolder = 1 THEN 1 ELSE 0 END) as totalFolders,
        SUM(CASE WHEN isFolder = 0 THEN 1 ELSE 0 END) as totalFiles,
        SUM(CASE WHEN isFolder = 0 THEN size ELSE 0 END) as totalBytes
      FROM migration_manifest 
      WHERE jobId = ?
    `, [jobId]);

    const totalFolders = manifestTotals?.totalFolders || 0;
    const totalFiles = manifestTotals?.totalFiles || 0;
    const totalBytes = manifestTotals?.totalBytes || 0;

    if (totalFolders === 0 && totalFiles === 0) {
      throw new ManifestError('Manifest contains 0 items to migrate.');
    }

    // 3. Google Shortcut Support
    for (let i = 0; i < payload.sourceSelection.length; i++) {
      const item = payload.sourceSelection[i];
      if (item.mimeType === 'application/vnd.google-apps.shortcut') {
        const targetId = item.shortcutDetails?.targetId;
        if (!targetId) {
            throw new ShortcutResolutionError(`Shortcut ${item.id} has no targetId`);
        }
        
        console.log(`[SHORTCUT] Shortcut detected | Original ID: ${item.id} | Target ID: ${targetId}`);
        try {
            const realFolder = await driveService.getFolderInfo('source', targetId);
            payload.sourceSelection[i] = {
               ...realFolder,
               parentId: item.parentId
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
    
    await updateJobStatus(jobId, 'STARTING');
    
    const { migrationWorker } = await import('./MigrationWorker');
    
    // Explicit background dispatch
    migrationWorker.executeMigration({
      ...payload,
      jobId,
      status: 'starting',
      totalFolders,
      totalFiles,
      totalBytes,
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
