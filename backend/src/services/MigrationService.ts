import { createJob } from '../utils/database';
import { queueService } from './QueueService';

export class MigrationService {
  public async startMigrationJob(payload: any) {
    // 1. Validate the payload structure
    if (!payload.sourceSelection || !Array.isArray(payload.sourceSelection) || payload.sourceSelection.length === 0) {
      throw new Error('Missing source selection');
    }
    if (!payload.destinationFolder) {
      throw new Error('Missing destination folder');
    }
    if (!payload.options) {
      throw new Error('Missing transfer options');
    }

    if (!payload.manifestId) {
      throw new Error('Missing manifest ID');
    }

    const jobId = payload.manifestId;
    console.log(`[Backend] Creating migration job ${jobId}`);

    // Write to DB
    await createJob(jobId, payload);
    
    // Notify queue
    queueService.notifyNewJob();

    return {
      jobId,
      status: 'queued',
      message: 'Migration engine initialized.'
    };
  }
}

export const migrationService = new MigrationService();
