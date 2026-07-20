import { getDb, updateJobStatus } from '../utils/database';
import { migrationWorker } from './MigrationWorker';

class QueueService {
  private isProcessing = false;

  public async init() {
    console.log('[QueueService] Initialized.');
    // Check for interrupted jobs
    const db = await getDb();
    await db.run(`UPDATE migration_jobs SET status = 'queued' WHERE status = 'running'`);
    
    // Start processing loop
    this.poll();
  }

  private async poll() {
    if (this.isProcessing) return;

    try {
      const db = await getDb();
      const job = await db.get(`SELECT * FROM migration_jobs WHERE status = 'queued' ORDER BY startedAt ASC LIMIT 1`);

      if (job) {
        this.isProcessing = true;
        await updateJobStatus(job.jobId, 'running');
        
        try {
          await migrationWorker.executeMigration(job);
          await updateJobStatus(job.jobId, 'completed');
        } catch (error: any) {
          console.error(`[QueueService] Job ${job.jobId} failed:`, error);
          await updateJobStatus(job.jobId, 'failed');
        } finally {
          this.isProcessing = false;
        }
      }
    } catch (e) {
      console.error('[QueueService] Poll error:', e);
    }

    // Schedule next poll
    setTimeout(() => this.poll(), 2000);
  }

  public notifyNewJob() {
    this.poll();
  }
}

export const queueService = new QueueService();
