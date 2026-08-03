// @ts-nocheck
import { ManifestStorage, ManifestItem } from '../utils/ManifestStorage';
import { prisma, updateJobStatus, updateJobProgress, logJobEvent } from "../utils/database";

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
      try {
        await prisma.$transaction([
          prisma.migrationManifest.update({
            where: { jobId_id: { jobId: this.jobId, id: sourceId } },
            data: { createdDestId: destId, status: 'SUCCESS' }
          })
        ]);
      } catch (e: any) {
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
      const res = await prisma.migrationManifest.updateMany({
        where: { jobId: this.jobId, sourceParentId, status: 'PENDING' },
        data: { status: 'QUEUED' }
      });
      if (res && res.count > 0) {
         console.log(`[MigrationStateManager] Queued ${res.count} items for parent folder ${sourceParentId}`);
      }
    });
  }

  public updateState(itemId: string, status: ManifestItem['status']): Promise<void> {
    return this.enqueueMutationAndWait(async () => {
      await ManifestStorage.updateItemStatus(this.jobId, itemId, status);
    });
  }

  private activeTransferredBytes: bigint = BigInt(0);
  private speedSamples: number[] = [];
  private lastEmitTime: number = Date.now();
  private lastTransferredBytes: bigint = BigInt(0);

  public reportProgressBytes(bytes: number) {
     this.activeTransferredBytes += BigInt(bytes);
  }

  private async emitProgress() {
    if (this.isFinalized || this.invariantViolation) return;
    
    try {
      const stats = await prisma.migrationManifest.groupBy({
        by: ['status', 'isFolder'],
        where: { jobId: this.jobId },
        _count: { id: true },
        _sum: { size: true }
      });

      let completedFolders = 0, completedFiles = 0, dbTransferredBytes = BigInt(0);
      let failedFiles = 0, totalFolders = 0, totalFiles = 0, totalBytes = BigInt(0);

      for (const stat of stats) {
        if (stat.isFolder) {
          totalFolders += stat._count.id;
          if (stat.status === 'SUCCESS') completedFolders += stat._count.id;
        } else {
          totalFiles += stat._count.id;
          totalBytes += stat._sum.size || BigInt(0);
          if (stat.status === 'SUCCESS') {
            completedFiles += stat._count.id;
            dbTransferredBytes += stat._sum.size || BigInt(0);
          }
          if (stat.status === 'FAILED') {
            failedFiles += stat._count.id;
          }
        }
      }

      // Use active bytes if it's greater than db committed bytes (since chunks commit success at the end)
      const transferredBytes = this.activeTransferredBytes > dbTransferredBytes ? this.activeTransferredBytes : dbTransferredBytes;
      
      const now = Date.now();
      const elapsedSec = (now - this.lastEmitTime) / 1000;
      let speed = 0;
      let eta = 0;
      
      if (elapsedSec >= 1.0) {
          const bytesDiff = Number(transferredBytes - this.lastTransferredBytes);
          if (bytesDiff > 0) {
             speed = bytesDiff / elapsedSec; // bytes per second
             
             // Keep a rolling average of the last 5 samples for smoother ETA
             this.speedSamples.push(speed);
             if (this.speedSamples.length > 5) this.speedSamples.shift();
             
             const avgSpeed = this.speedSamples.reduce((a, b) => a + b, 0) / this.speedSamples.length;
             const remainingBytes = Number(totalBytes - transferredBytes);
             
             if (avgSpeed > 0 && remainingBytes > 0) {
                eta = remainingBytes / avgSpeed;
             }
          }
          this.lastTransferredBytes = transferredBytes;
          this.lastEmitTime = now;
      }
      
      const activeFile = await prisma.migrationManifest.findFirst({
        where: { jobId: this.jobId, isFolder: false, status: { in: ['UPLOADING', 'DOWNLOADING', 'VERIFYING'] } },
        select: { name: true }
      });
      const activeFolder = await prisma.migrationManifest.findFirst({
        where: { jobId: this.jobId, isFolder: true, status: { in: ['QUEUED', 'UPLOADING', 'VERIFYING'] } },
        select: { name: true }
      });

      const updates: any = {
        completedFolders,
        completedFiles,
        transferredBytes,
        failedFiles,
        totalFolders,
        totalFiles,
        totalBytes,
        speed,
        eta,
        currentFile: activeFile?.name || '',
        currentFolder: activeFolder?.name || '',
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
      const stats = await prisma.migrationManifest.groupBy({
        by: ['status'],
        where: { jobId: this.jobId },
        _count: { id: true }
      });

      let queued = 0, uploading = 0, verifying = 0, success = 0, failed = 0, pending = 0;
      let total = 0;

      for (const stat of stats) {
        total += stat._count.id;
        if (stat.status === 'QUEUED') queued += stat._count.id;
        else if (stat.status === 'UPLOADING') uploading += stat._count.id;
        else if (stat.status === 'VERIFYING') verifying += stat._count.id;
        else if (stat.status === 'SUCCESS') success += stat._count.id;
        else if (stat.status === 'FAILED') failed += stat._count.id;
        else if (stat.status === 'PENDING') pending += stat._count.id;
      }

      if (total > 0) {
        const sum = queued + uploading + verifying + success + failed + pending;
        if (sum !== total) {
           this.invariantViolation = true;
           throw new Error(`[INVARIANT VIOLATION] Manifest states do not sum to total! Sum: ${sum}, Total: ${total}`);
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
          const stats = await prisma.migrationManifest.groupBy({
            by: ['status'],
            where: { jobId: this.jobId },
            _count: { id: true }
          });

          let pending = 0, queued = 0, uploading = 0, verifying = 0, failed = 0;
          for (const stat of stats) {
            if (stat.status === 'PENDING') pending += stat._count.id;
            else if (stat.status === 'QUEUED') queued += stat._count.id;
            else if (stat.status === 'UPLOADING') uploading += stat._count.id;
            else if (stat.status === 'VERIFYING') verifying += stat._count.id;
            else if (stat.status === 'FAILED') failed += stat._count.id;
          }

          const unresolved = pending + queued + uploading + verifying;

          if (unresolved > 0) {
            this.invariantViolation = true;
            const msg = `[INVARIANT VIOLATION] Attempted to finalize but found ${unresolved} non-terminal items (Pending: ${pending}, Queued: ${queued}, Uploading: ${uploading}, Verifying: ${verifying}).`;
            console.error(msg);
            await updateJobStatus(this.jobId, 'failed');
            throw new Error(msg);
          }

          this.isFinalized = true;
          clearInterval(this.intervalId);
          
          const finalStatus = failed > 0 ? 'completed_with_errors' : 'completed';
          await prisma.migrationJob.update({
            where: { id: this.jobId },
            data: { state: finalStatus === 'completed_with_errors' ? 'COMPLETED' : 'COMPLETED', completedAt: new Date() } // Mapped to valid enum
          });
          await logJobEvent(this.jobId, `[STATE] COMPLETED - Final Status: ${finalStatus}`);
        } catch (e: any) {
          console.error(`[MigrationStateManager] Finalization failed: ${e.message}`);
          throw e;
        }
      }
    });
  }

  public async getSummaryStats(manifestId?: string) {
    try {
      const targetId = manifestId || this.jobId;
      const stats = await prisma.migrationManifest.groupBy({
        by: ['status', 'isFolder'],
        where: { jobId: targetId },
        _count: { id: true },
        _sum: { size: true }
      });

      let completedFiles = 0;
      let failedFiles = 0;
      let transferredBytes = BigInt(0);

      for (const stat of stats) {
        if (!stat.isFolder) {
          if (stat.status === 'SUCCESS') {
            completedFiles += stat._count.id;
            transferredBytes += stat._sum.size || BigInt(0);
          } else if (stat.status === 'FAILED') {
            failedFiles += stat._count.id;
          }
        }
      }

      return { completedFiles, failedFiles, transferredBytes };
    } catch (e: any) {
      console.warn(`[MigrationStateManager] getSummaryStats warning: ${e.message}`);
      return { completedFiles: 0, failedFiles: 0, transferredBytes: BigInt(0) };
    }
  }
}
