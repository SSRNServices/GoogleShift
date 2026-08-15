// @ts-nocheck
import { ManifestStorage, ManifestItem } from '../utils/ManifestStorage';
import { prisma, updateJobStatus, updateJobProgress, logJobEvent } from '../utils/database';

/** How often to emit progress to the DB */
const PROGRESS_EMIT_INTERVAL_MS = 2_000;

/**
 * How many consecutive zero-byte samples before we declare the migration stalled.
 * Each sample is taken every PROGRESS_EMIT_INTERVAL_MS, so 5 samples = 10 seconds.
 */
const STALL_SAMPLE_THRESHOLD = 5;

/** Maximum time (ms) any individual DB write may take before it is considered hung */
const DB_WRITE_TIMEOUT_MS = 20_000;

/**
 * MigrationStateManager
 *
 * Responsibilities:
 *  1. Emit live progress (bytes, speed, ETA, file counts) to the DB on an interval
 *  2. Provide atomic state-transition helpers for workers (commitSuccess, updateState, …)
 *  3. Detect stalled progress and expose that via `isStalled`
 *  4. Finalize the migration when all work is done
 *
 * KEY FIX vs previous version:
 *  - Write mutations are NO LONGER serialized through a single queue bottleneck.
 *    Independent writes (e.g. two workers committing different files) run in parallel.
 *    Only writes that MUST be ordered (commitFolderSuccess → queueChildren) are
 *    chained explicitly by the caller.
 *  - ETA: when bytesDiff === 0 for STALL_SAMPLE_THRESHOLD consecutive samples,
 *    speed is set to 0 and eta is set to null (displayed as "Calculating…" in the UI).
 *  - transferredBytes in progress reports uses DB-authoritative SUCCESS sum, with
 *    in-flight bytes used only as an optimistic upper-bound hint.
 */
export class MigrationStateManager {
  private jobId: string;
  private manifestId: string;
  private isFinalized: boolean = false;

  // ── Progress interval ─────────────────────────────────────────────────────────
  private progressIntervalId: NodeJS.Timeout | null = null;

  // ── In-memory byte counter (updated synchronously from worker data events) ────
  private activeTransferredBytes: bigint = BigInt(0);

  // ── Speed / ETA tracking ──────────────────────────────────────────────────────
  private speedSamples: number[] = [];
  private lastEmitTime: number = 0;
  private lastTransferredBytes: bigint = BigInt(0);
  private zeroSpeedCount: number = 0;

  // ── Stall flag (read by FileScheduler / WorkerWatchdog) ──────────────────────
  public isStalled: boolean = false;

  // ── Pending write counter (used by FileScheduler to detect idle) ──────────────
  private pendingWrites: number = 0;

  constructor(jobId: string, manifestId?: string) {
    this.jobId = jobId;
    this.manifestId = manifestId || jobId;

    // Progress emission runs independently — never blocks worker commits
    this.progressIntervalId = setInterval(async () => {
      if (!this.isFinalized) {
        try {
          await this.emitProgress();
        } catch (e: any) {
          console.error(`[MigrationStateManager] Progress emit error: ${e.message}`);
        }
      }
    }, PROGRESS_EMIT_INTERVAL_MS);
  }

  // ── Pending write count (FileScheduler uses this to wait for quiescence) ──────

  public getPendingWriteCount(): number {
    return this.pendingWrites;
  }

  // ── Private write wrapper with timeout ────────────────────────────────────────

  private async timedWrite<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.pendingWrites++;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`DB write timeout [${label}] after ${DB_WRITE_TIMEOUT_MS}ms`)),
            DB_WRITE_TIMEOUT_MS
          )
        )
      ]);
    } finally {
      this.pendingWrites = Math.max(0, this.pendingWrites - 1);
    }
  }

  // ── Public write API — all parallel (no single-lane bottleneck) ───────────────

  /**
   * Mark a file as SUCCESS. Parallel with other commitSuccess calls.
   */
  public async commitSuccess(item: ManifestItem): Promise<void> {
    return this.timedWrite(`commitSuccess(${item.id})`, async () => {
      await ManifestStorage.updateItemStatus(this.manifestId, item.id, 'SUCCESS');
    });
  }

  /**
   * Mark a folder as created in the destination. Must be awaited before queueChildren.
   */
  public async commitFolderSuccess(sourceId: string, destId: string): Promise<void> {
    return this.timedWrite(`commitFolderSuccess(${sourceId})`, async () => {
      try {
        await ManifestStorage.updateCreatedDestId(this.manifestId, sourceId, destId);
        await ManifestStorage.updateItemStatus(this.manifestId, sourceId, 'SUCCESS');
      } catch (e: any) {
        console.error(
          `[MigrationStateManager] Failed to commit folder SUCCESS for ${sourceId}: ${e.message}`
        );
        throw e;
      }
    });
  }

  public async commitFolderError(sourceId: string): Promise<void> {
    return this.timedWrite(`commitFolderError(${sourceId})`, async () => {
      await ManifestStorage.updateItemStatus(this.manifestId, sourceId, 'FAILED');
    });
  }

  /**
   * Queue the children of a freshly-created folder.
   * Caller must await commitFolderSuccess first to ensure destId is available.
   */
  public async queueChildren(sourceParentId: string): Promise<void> {
    return this.timedWrite(`queueChildren(${sourceParentId})`, async () => {
      const res = await ManifestStorage.queueChildrenOf(this.manifestId, sourceParentId);
      if (res && res.count > 0) {
        console.log(
          `[MigrationStateManager] QUEUE_CHILDREN | Parent: ${sourceParentId} | Count: ${res.count}`
        );
      }
    });
  }

  /**
   * Transition a single manifest item to a new status.
   * Uses ManifestStorage which guards against backwards transitions (SUCCESS → anything else).
   */
  public async updateState(itemId: string, status: ManifestItem['status']): Promise<void> {
    return this.timedWrite(`updateState(${itemId}, ${status})`, async () => {
      await ManifestStorage.updateItemStatus(this.manifestId, itemId, status);
    });
  }

  /**
   * Directly set a file back to QUEUED, bypassing the SUCCESS guard.
   * Used by the watchdog and retry path to rescue stuck UPLOADING items.
   */
  public async resetToQueued(itemId: string): Promise<void> {
    return this.timedWrite(`resetToQueued(${itemId})`, async () => {
      const item = await ManifestStorage.getItem(this.manifestId, itemId);
      if (item && ['UPLOADING', 'DOWNLOADING', 'VERIFYING', 'QUEUED'].includes(item.status)) {
        await ManifestStorage.updateItemStatus(this.manifestId, itemId, 'QUEUED');
      }
    });
  }

  /**
   * Recover items stuck in UPLOADING/DOWNLOADING/VERIFYING at the start of a run.
   * Called once by CopyService before the worker pool starts.
   */
  public async recoverStalledItems(): Promise<void> {
    const recovered = await ManifestStorage.updateManyStatus(
      this.manifestId,
      { isFolder: false, statusIn: ['UPLOADING', 'DOWNLOADING', 'VERIFYING'] },
      'QUEUED'
    );
    if (recovered.count > 0) {
      console.warn(
        `[MigrationStateManager] RECOVERY | Moved ${recovered.count} stalled items ` +
        `(UPLOADING/DOWNLOADING/VERIFYING) back to QUEUED.`
      );
    }
  }

  /**
   * Called by UploadWorker data events — synchronous, never awaited.
   * Updates the in-memory byte counter for real-time progress display.
   */
  public reportProgressBytes(bytes: number): void {
    this.activeTransferredBytes += BigInt(bytes);
  }

  // ── Progress emission ─────────────────────────────────────────────────────────

  private async emitProgress(): Promise<void> {
    if (this.isFinalized) return;

    try {
      const summaryStats = await ManifestStorage.getSummaryStats(this.manifestId);
      const completedFolders = 0; // Folder counts tracked in summary
      const completedFiles = summaryStats.completedFiles;
      const dbTransferredBytes = BigInt(summaryStats.transferredBytes);
      const failedFiles = summaryStats.failedFiles;
      const totalFolders = summaryStats.totalFolders;
      const totalFiles = summaryStats.totalFiles;
      const totalBytes = BigInt(summaryStats.totalBytes);

      // Use in-flight bytes only as an upper-bound hint — never less than DB bytes
      const transferredBytes =
        this.activeTransferredBytes > dbTransferredBytes
          ? this.activeTransferredBytes
          : dbTransferredBytes;

      // ── Speed and ETA calculation ─────────────────────────────────────────────
      const now = Date.now();
      const elapsedSec = (now - this.lastEmitTime) / 1000;
      let speed = 0;
      let eta: number | null = null;

      if (elapsedSec >= 1.0 || this.lastEmitTime === 0) {
        const bytesDiff = Number(transferredBytes - this.lastTransferredBytes);

        if (bytesDiff > 0) {
          // Progress is being made
          this.zeroSpeedCount = 0;
          speed = bytesDiff / elapsedSec;

          // Rolling average over last 10 samples
          this.speedSamples.push(speed);
          if (this.speedSamples.length > 10) this.speedSamples.shift();

          const avgSpeed = this.speedSamples.reduce((a, b) => a + b, 0) / this.speedSamples.length;
          const remainingBytes = Number(totalBytes - transferredBytes);

          if (avgSpeed > 0 && remainingBytes > 0) {
            eta = remainingBytes / avgSpeed;
          }

          this.isStalled = false;
        } else {
          // No byte progress this interval
          this.zeroSpeedCount++;
          speed = 0;
          eta = null; // "Calculating..." — do NOT use stale ETA

          if (this.zeroSpeedCount >= STALL_SAMPLE_THRESHOLD) {
            this.isStalled = true;
          }
        }

        this.lastTransferredBytes = transferredBytes;
        this.lastEmitTime = now;
      }

      // ── Current active file / folder ──────────────────────────────────────────
      const activeFile = await ManifestStorage.getPendingFiles(this.manifestId, 1);
      const activeFileName = activeFile.length > 0 ? activeFile[0].name : '';
      const activeFolder = await ManifestStorage.getPendingFoldersByDepth(this.manifestId);
      const activeFolderName = activeFolder.length > 0 ? activeFolder[0].name : '';

      await updateJobProgress(this.jobId, {
        completedFolders,
        completedFiles,
        transferredBytes,
        failedFiles,
        totalFolders,
        totalFiles,
        totalBytes,
        speed,
        eta: eta ?? 0, // DB stores 0 for null/unknown — UI interprets 0 as "Calculating..."
        currentFile: activeFileName,
        currentFolder: activeFolderName,
        pendingDBWrites: this.pendingWrites
      });

    } catch (e: any) {
      console.error(`[MigrationStateManager] emitProgress error: ${e.message}`);
    }
  }

  // ── Finalization ──────────────────────────────────────────────────────────────

  public async finalizeMigration(activeWorkers: number, queueLength: number): Promise<void> {
    if (this.isFinalized) return;
    if (activeWorkers !== 0 || queueLength !== 0) return;

    try {
      const pending = await ManifestStorage.countItems(this.manifestId, { status: 'PENDING' });
      const queued = await ManifestStorage.countItems(this.manifestId, { status: 'QUEUED' });
      const uploading = await ManifestStorage.countItems(this.manifestId, { status: 'UPLOADING' });
      const verifying = await ManifestStorage.countItems(this.manifestId, { status: 'VERIFYING' });
      const failed = await ManifestStorage.countItems(this.manifestId, { status: 'FAILED' });

      const unresolved = pending + queued + uploading + verifying;

      if (unresolved > 0) {
        const msg =
          `[INVARIANT VIOLATION] Attempted to finalize but found ${unresolved} ` +
          `non-terminal items (Pending: ${pending}, Queued: ${queued}, ` +
          `Uploading: ${uploading}, Verifying: ${verifying}).`;
        console.error(msg);
        await updateJobStatus(this.jobId, 'failed');
        throw new Error(msg);
      }

      this.isFinalized = true;
      if (this.progressIntervalId) {
        clearInterval(this.progressIntervalId);
        this.progressIntervalId = null;
      }

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

  public stopProgressInterval(): void {
    if (this.progressIntervalId) {
      clearInterval(this.progressIntervalId);
      this.progressIntervalId = null;
    }
  }

  public async getSummaryStats(manifestId?: string) {
    try {
      const targetId = manifestId || this.manifestId;
      const res = await ManifestStorage.getSummaryStats(targetId);
      return {
        completedFiles: res.completedFiles,
        failedFiles: res.failedFiles,
        transferredBytes: BigInt(res.transferredBytes)
      };
    } catch (e: any) {
      console.warn(`[MigrationStateManager] getSummaryStats warning: ${e.message}`);
      return { completedFiles: 0, failedFiles: 0, transferredBytes: BigInt(0) };
    }
  }
}
