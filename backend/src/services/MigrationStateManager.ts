import { ManifestStorage, ManifestItem } from '../utils/ManifestStorage';
import { getDb } from "../utils/database";

export class MigrationStateManager {
  private jobId: string;
  private isFinalized: boolean = false;
  private invariantViolation: boolean = false;
  
  // The serialized execution queue for all database writes
  private writeQueue: (() => Promise<void>)[] = [];
  private isProcessingQueue: boolean = false;
  private intervalId: NodeJS.Timeout;

  constructor(jobId: string) {
    this.jobId = jobId;
    this.intervalId = setInterval(() => {
      if (!this.isFinalized && !this.invariantViolation) {
        this.enqueueMutation(async () => {
          await this.validateManifestConsistency();
          await this.emitProgress(); // Batch progress updates (throttle to 1s)
        });
      }
    }, 1000);
  }
  
  public getPendingWriteCount(): number {
    return this.writeQueue.length;
  }

  private enqueueMutation(mutation: () => Promise<void>) {
    this.writeQueue.push(mutation);
    this.processQueue();
  }

  private async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    
    while (this.writeQueue.length > 0) {
      if (this.invariantViolation) {
         this.writeQueue = []; // clear queue on fatal error
         break;
      }
      
      const mutation = this.writeQueue.shift();
      if (mutation) {
        try {
          await mutation();
        } catch (e: any) {
          console.error(`[MigrationStateManager] Queue mutation failed: ${e.message}`);
        }
      }
    }
    
    this.isProcessingQueue = false;
  }

  private enqueueMutationAndWait(mutation: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
       this.enqueueMutation(async () => {
          try {
             await mutation();
             resolve();
          } catch(e) {
             reject(e);
          }
       });
    });
  }

  public commitSuccess(item: ManifestItem): Promise<void> {
    return this.enqueueMutationAndWait(async () => {
      await ManifestStorage.updateItemStatus(this.jobId, item.id, 'SUCCESS');
    });
  }

  public commitFolderSuccess(sourceId: string, destId: string): Promise<void> {
    return this.enqueueMutationAndWait(async () => {
      const db = await getDb();
      try {
        await db.run('BEGIN TRANSACTION');
        await ManifestStorage.updateCreatedDestId(this.jobId, sourceId, destId);
        await ManifestStorage.updateItemStatus(this.jobId, sourceId, 'SUCCESS');
        await db.run('COMMIT');
      } catch (e: any) {
        try { await db.run('ROLLBACK'); } catch (err) {}
        console.error(`[MigrationStateManager] Failed to commit folder SUCCESS for ${sourceId}: ${e.message}`);
        throw e;
      }
    });
  }

  public commitFolderError(sourceId: string): Promise<void> {
    return this.enqueueMutationAndWait(async () => {
      await ManifestStorage.updateItemStatus(this.jobId, sourceId, 'FAILED');
    });
  }

  public queueChildren(sourceParentId: string): Promise<void> {
    return this.enqueueMutationAndWait(async () => {
      const db = await getDb();
      const res = await db.run(
        `UPDATE migration_manifest SET status = 'QUEUED' WHERE jobId = ? AND sourceParentId = ? AND status = 'PENDING'`,
        [this.jobId, sourceParentId]
      );
      if (res && res.changes && res.changes > 0) {
         console.log(`[MigrationStateManager] Queued ${res.changes} items for parent folder ${sourceParentId}`);
      }
    });
  }

  public updateState(itemId: string, status: ManifestItem['status']): Promise<void> {
    return this.enqueueMutationAndWait(async () => {
      await ManifestStorage.updateItemStatus(this.jobId, itemId, status);
    });
  }

  private async emitProgress() {
    if (this.isFinalized || this.invariantViolation) return;
    
    try {
      const db = await getDb();
      const stats = await db.get(`
        SELECT 
          SUM(CASE WHEN isFolder = 1 AND status = 'SUCCESS' THEN 1 ELSE 0 END) as completedFolders,
          SUM(CASE WHEN isFolder = 0 AND status = 'SUCCESS' THEN 1 ELSE 0 END) as completedFiles,
          SUM(CASE WHEN isFolder = 0 AND status = 'SUCCESS' THEN size ELSE 0 END) as transferredBytes,
          SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failedFiles,
          SUM(CASE WHEN isFolder = 1 THEN 1 ELSE 0 END) as totalFolders,
          SUM(CASE WHEN isFolder = 0 THEN 1 ELSE 0 END) as totalFiles,
          SUM(CASE WHEN isFolder = 0 THEN size ELSE 0 END) as totalBytes
        FROM migration_manifest 
        WHERE jobId = ?
      `, [this.jobId]);

      if (!stats) return;

      const updates: any = {
        completedFolders: stats.completedFolders || 0,
        completedFiles: stats.completedFiles || 0,
        transferredBytes: stats.transferredBytes || 0,
        failedFiles: stats.failedFiles || 0,
        totalFolders: stats.totalFolders || 0,
        totalFiles: stats.totalFiles || 0,
        totalBytes: stats.totalBytes || 0,
        pendingDBWrites: this.writeQueue.length
      };

      await updateJobProgress(this.jobId, updates);
      await this.checkInvariants(updates);
    } catch (e: any) {
      console.error(`[MigrationStateManager] Error emitting progress: ${e.message}`);
    }
  }

  private async validateManifestConsistency() {
    try {
      const db = await getDb();
      const res = await db.get(`
        SELECT 
          SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) as queued,
          SUM(CASE WHEN status = 'UPLOADING' THEN 1 ELSE 0 END) as uploading,
          SUM(CASE WHEN status = 'VERIFYING' THEN 1 ELSE 0 END) as verifying,
          SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) as success,
          SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
          COUNT(*) as total
        FROM migration_manifest WHERE jobId = ?
      `, [this.jobId]);

      if (res && res.total > 0) {
        const sum = (res.queued || 0) + (res.uploading || 0) + (res.verifying || 0) + (res.success || 0) + (res.failed || 0) + (res.pending || 0);
        if (sum !== res.total) {
           this.invariantViolation = true;
           throw new Error(`[INVARIANT VIOLATION] Manifest states do not sum to total! Sum: ${sum}, Total: ${res.total}`);
        }
      }
    } catch(e: any) {
      console.error(e.message);
      if (this.invariantViolation) {
         await updateJobStatus(this.jobId, 'failed');
         throw e;
      }
    }
  }

  private async checkInvariants(stats: any) {
    if (stats.completedFiles > stats.totalFiles) {
      this.invariantViolation = true;
      throw new Error(`[INVARIANT VIOLATION] Completed files (${stats.completedFiles}) > Total Files (${stats.totalFiles})`);
    }
    if (stats.completedFolders > stats.totalFolders) {
      this.invariantViolation = true;
      throw new Error(`[INVARIANT VIOLATION] Completed folders (${stats.completedFolders}) > Total Folders (${stats.totalFolders})`);
    }
  }

  public finalizeMigration(activeWorkers: number, queueLength: number): Promise<void> {
    return this.enqueueMutationAndWait(async () => {
      if (this.isFinalized) return;
      
      if (activeWorkers === 0 && queueLength === 0) {
        try {
          const db = await getDb();
          const pendingCount = await db.get(`
            SELECT 
              SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
              SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) as queued,
              SUM(CASE WHEN status = 'UPLOADING' THEN 1 ELSE 0 END) as uploading,
              SUM(CASE WHEN status = 'VERIFYING' THEN 1 ELSE 0 END) as verifying,
              SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed
            FROM migration_manifest 
            WHERE jobId = ?
          `, [this.jobId]);

          const unresolved = (pendingCount.pending || 0) + (pendingCount.queued || 0) + (pendingCount.uploading || 0) + (pendingCount.verifying || 0);

          if (unresolved > 0) {
            this.invariantViolation = true;
            const msg = `[INVARIANT VIOLATION] Attempted to finalize but found ${unresolved} non-terminal items (Pending: ${pendingCount.pending}, Queued: ${pendingCount.queued}, Uploading: ${pendingCount.uploading}, Verifying: ${pendingCount.verifying}).`;
            console.error(msg);
            await updateJobStatus(this.jobId, 'failed');
            throw new Error(msg);
          }

          this.isFinalized = true;
          clearInterval(this.intervalId);
          
          const finalStatus = (pendingCount.failed || 0) > 0 ? 'completed_with_errors' : 'completed';
          await updateJobStatus(this.jobId, finalStatus);
          await logJobEvent(this.jobId, `[STATE] COMPLETED - Final Status: ${finalStatus}`);
        } catch (e: any) {
          console.error(`[MigrationStateManager] Finalization failed: ${e.message}`);
          throw e;
        }
      }
    });
  }
}
