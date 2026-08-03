// @ts-nocheck
import { ManifestStorage, ManifestItem } from '../utils/ManifestStorage';
import { prisma, updateJobStatus, updateJobProgress, logJobEvent } from "../utils/database";

/** Maximum time to wait for a single DB write-queue mutation before aborting it */
const MUTATION_TIMEOUT_MS = 30_000; // 30 seconds

/** How often to emit progress to the DB */
const PROGRESS_EMIT_INTERVAL_MS = 2_000;

export class MigrationStateManager {
  private jobId: string;
  private manifestId: string;
  private isFinalized: boolean = false;
  private invariantViolation: boolean = false;

  // ─── Serialized write queue for blocking mutations (commitSuccess, updateState, etc.)
  private writeQueue: Array<{ fn: () => Promise<void>; resolve: () => void; reject: (e: any) => void }> = [];
  private isProcessingQueue: boolean = false;

  // ─── Separate non-blocking progress interval (never blocks the write queue)
  private progressIntervalId: NodeJS.Timeout;

  // ─── In-memory byte counter (updated from worker data events; never awaited)
  private activeTransferredBytes: bigint = BigInt(0);
  private speedSamples: number[] = [];
  private lastEmitTime: number = Date.now();
  private lastTransferredBytes: bigint = BigInt(0);

  constructor(jobId: string, manifestId: string) {
    this.jobId = jobId;
    this.manifestId = manifestId;

    // Progress emission runs independently — it NEVER goes into the write queue.
    // This prevents the progress interval from blocking commitSuccess() calls and
    // prevents commitSuccess() from being starved behind a slow progress query.
    this.progressIntervalId = setInterval(async () => {
      if (!this.isFinalized && !this.invariantViolation) {
        try {
          await this.emitProgress();
        } catch (e: any) {
          console.error(`[MigrationStateManager] Progress emit error: ${e.message}`);
        }
      }
    }, PROGRESS_EMIT_INTERVAL_MS);
  }

  public getPendingWriteCount(): number {
    return this.writeQueue.length;
  }

  // ─── Write queue processor (only used for mutations that callers await) ──────
  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.writeQueue.push({ fn, resolve, reject });
      this.drainQueue();
    });
  }

  private async drainQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.writeQueue.length > 0) {
      if (this.invariantViolation) {
        // Drain remaining items by rejecting them
        for (const item of this.writeQueue) {
          item.reject(new Error('MigrationStateManager: invariant violation, aborting writes'));
        }
        this.writeQueue = [];
        break;
      }

      const item = this.writeQueue.shift();
      if (!item) continue;

      try {
        // Per-mutation timeout guard: no single DB write may block forever
        await Promise.race([
          item.fn(),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`Mutation timeout after ${MUTATION_TIMEOUT_MS}ms`)), MUTATION_TIMEOUT_MS)
          )
        ]);
        item.resolve();
      } catch (e: any) {
        console.error(`[MigrationStateManager] Write queue mutation failed: ${e.message}`);
        item.reject(e);
      }
    }

    this.isProcessingQueue = false;
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  public commitSuccess(item: ManifestItem): Promise<void> {
    return this.enqueueWrite(async () => {
      await ManifestStorage.updateItemStatus(this.manifestId, item.id, 'SUCCESS');
    });
  }

  public commitFolderSuccess(sourceId: string, destId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      try {
        await prisma.$transaction([
          prisma.migrationManifest.update({
            where: { jobId_id: { jobId: this.manifestId, id: sourceId } },
            data: { createdDestId: destId, status: 'SUCCESS' }
          })
        ]);
      } catch (e: any) {
        console.error(
          `[MigrationStateManager] Failed to commit folder SUCCESS for ${sourceId}: ${e.message}`
        );
        throw e;
      }
    });
  }

  public commitFolderError(sourceId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      await ManifestStorage.updateItemStatus(this.manifestId, sourceId, 'FAILED');
    });
  }

  public queueChildren(sourceParentId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      const res = await prisma.migrationManifest.updateMany({
        where: { jobId: this.manifestId, sourceParentId, status: 'PENDING' },
        data: { status: 'QUEUED' }
      });
      if (res && res.count > 0) {
        console.log(
          `[MigrationStateManager] QUEUE_CHILDREN | Parent: ${sourceParentId} | Count: ${res.count}`
        );
      }
    });
  }

  public updateState(itemId: string, status: ManifestItem['status']): Promise<void> {
    return this.enqueueWrite(async () => {
      await ManifestStorage.updateItemStatus(this.manifestId, itemId, status);
    });
  }

  /**
   * Recover stuck UPLOADING/DOWNLOADING items back to QUEUED.
   * Called at the start of CopyService to heal items left in a terminal-pending
   * state by a previous crashed run.
   */
  public async recoverStalledItems(): Promise<void> {
    const recovered = await prisma.migrationManifest.updateMany({
      where: {
        jobId: this.manifestId,
        isFolder: false,
        status: { in: ['UPLOADING', 'DOWNLOADING', 'VERIFYING'] }
      },
      data: { status: 'QUEUED' }
    });
    if (recovered.count > 0) {
      console.warn(
        `[MigrationStateManager] RECOVERY | Moved ${recovered.count} stalled items ` +
        `(UPLOADING/DOWNLOADING/VERIFYING) back to QUEUED.`
      );
    }
  }

  /** Called by UploadWorker data events — intentionally synchronous & non-blocking */
  public reportProgressBytes(bytes: number) {
    this.activeTransferredBytes += BigInt(bytes);
  }

  // ─── Progress emission (runs on its own interval, never in the write queue) ──

  private async emitProgress() {
    if (this.isFinalized || this.invariantViolation) return;

    try {
      const stats = await prisma.migrationManifest.groupBy({
        by: ['status', 'isFolder'],
        where: { jobId: this.manifestId },
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
          if (stat.status === 'FAILED') failedFiles += stat._count.id;
        }
      }

      // Use in-flight bytes if ahead of DB-committed bytes
      const transferredBytes =
        this.activeTransferredBytes > dbTransferredBytes
          ? this.activeTransferredBytes
          : dbTransferredBytes;

      const now = Date.now();
      const elapsedSec = (now - this.lastEmitTime) / 1000;
      let speed = 0;
      let eta = 0;

      if (elapsedSec >= 1.0) {
        const bytesDiff = Number(transferredBytes - this.lastTransferredBytes);
        if (bytesDiff > 0) {
          speed = bytesDiff / elapsedSec;
          this.speedSamples.push(speed);
          if (this.speedSamples.length > 5) this.speedSamples.shift();
          const avgSpeed = this.speedSamples.reduce((a, b) => a + b, 0) / this.speedSamples.length;
          const remainingBytes = Number(totalBytes - transferredBytes);
          if (avgSpeed > 0 && remainingBytes > 0) eta = remainingBytes / avgSpeed;
        }
        this.lastTransferredBytes = transferredBytes;
        this.lastEmitTime = now;
      }

      const activeFile = await prisma.migrationManifest.findFirst({
        where: {
          jobId: this.manifestId,
          isFolder: false,
          status: { in: ['UPLOADING', 'DOWNLOADING', 'VERIFYING'] }
        },
        select: { name: true }
      });
      const activeFolder = await prisma.migrationManifest.findFirst({
        where: {
          jobId: this.manifestId,
          isFolder: true,
          status: { in: ['QUEUED', 'UPLOADING', 'VERIFYING'] }
        },
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

      // Lightweight invariant: never emit completed > total
      if (completedFiles > totalFiles || completedFolders > totalFolders) {
        this.invariantViolation = true;
        const msg =
          `[INVARIANT VIOLATION] Completed (files=${completedFiles}, folders=${completedFolders}) ` +
          `> Total (files=${totalFiles}, folders=${totalFolders})`;
        console.error(msg);
        await updateJobStatus(this.jobId, 'failed');
      }
    } catch (e: any) {
      console.error(`[MigrationStateManager] emitProgress error: ${e.message}`);
    }
  }

  // ─── Finalization ─────────────────────────────────────────────────────────────

  public finalizeMigration(activeWorkers: number, queueLength: number): Promise<void> {
    return this.enqueueWrite(async () => {
      if (this.isFinalized) return;

      if (activeWorkers === 0 && queueLength === 0) {
        try {
          const stats = await prisma.migrationManifest.groupBy({
            by: ['status'],
            where: { jobId: this.manifestId },
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
            const msg =
              `[INVARIANT VIOLATION] Attempted to finalize but found ${unresolved} ` +
              `non-terminal items (Pending: ${pending}, Queued: ${queued}, ` +
              `Uploading: ${uploading}, Verifying: ${verifying}).`;
            console.error(msg);
            await updateJobStatus(this.jobId, 'failed');
            throw new Error(msg);
          }

          this.isFinalized = true;
          clearInterval(this.progressIntervalId);

          const finalStatus = failed > 0 ? 'completed_with_errors' : 'completed';
          await prisma.migrationJob.update({
            where: { id: this.jobId },
            data: { state: 'COMPLETED', completedAt: new Date() }
          });
          await logJobEvent(this.jobId, `[STATE] COMPLETED - Final Status: ${finalStatus}`);
          console.log(
            `[MigrationStateManager] JOB_COMPLETE | JobId: ${this.jobId} | ` +
            `Status: ${finalStatus} | Failed: ${failed}`
          );
        } catch (e: any) {
          console.error(`[MigrationStateManager] Finalization failed: ${e.message}`);
          throw e;
        }
      }
    });
  }

  public stopProgressInterval() {
    clearInterval(this.progressIntervalId);
  }

  public async getSummaryStats(manifestId?: string) {
    try {
      const targetId = manifestId || this.manifestId;
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
