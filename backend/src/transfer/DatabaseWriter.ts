import { getDb } from '../utils/database';
import { eventBus, MigrationEvent } from './EventBus';
import { ManifestStorage } from '../utils/ManifestStorage';

export class DatabaseWriter {
  private jobId: string;
  private queue: MigrationEvent[] = [];
  private isProcessing = false;
  private isActive = true;

  constructor(jobId: string) {
    this.jobId = jobId;
    
    // Subscribe to events that require database writes
    eventBus.onEvent('FolderCreated', this.handleEvent.bind(this));
    eventBus.onEvent('FolderFailed', this.handleEvent.bind(this));
    eventBus.onEvent('UploadFinished', this.handleEvent.bind(this));
    eventBus.onEvent('UploadFailed', this.handleEvent.bind(this));
  }

  private handleEvent(event: MigrationEvent) {
    if (event.jobId !== this.jobId) return;
    this.queue.push(event);
    this.processQueue();
  }

  public stop() {
    this.isActive = false;
  }

  public async drain(): Promise<void> {
    while (this.queue.length > 0 || this.isProcessing) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift();
        if (!event) continue;

        const db = await getDb();
        try {
          await db.run('BEGIN TRANSACTION');

          if (event.type === 'FolderCreated') {
            await ManifestStorage.updateCreatedDestId(this.jobId, event.sourceId, event.destId);
            await ManifestStorage.updateItemStatus(this.jobId, event.sourceId, 'COMPLETED');
            eventBus.emitEvent({ type: 'FolderMapped', jobId: this.jobId, sourceId: event.sourceId, destId: event.destId });
          } 
          else if (event.type === 'FolderFailed') {
            await ManifestStorage.updateItemStatus(this.jobId, event.sourceId, 'FAILED');
          }
          else if (event.type === 'UploadFinished') {
            await ManifestStorage.updateItemStatus(this.jobId, event.sourceId, 'COMPLETED');
          }
          else if (event.type === 'UploadFailed') {
            await ManifestStorage.updateItemStatus(this.jobId, event.sourceId, 'FAILED');
          }

          await db.run('COMMIT');
        } catch (error: any) {
          try {
            await db.run('ROLLBACK');
          } catch (rollbackError: any) {
            console.error(`[DatabaseWriter] Failed to rollback transaction: ${rollbackError.message}`);
          }
          console.error(`[DatabaseWriter] Failed to process event ${event.type} for sourceId ${'sourceId' in event ? event.sourceId : 'unknown'}: ${error.message}`);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}
