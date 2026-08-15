import { drive_v3 } from 'googleapis';
import { ManifestStorage, ManifestItem } from '../utils/ManifestStorage';
import { AdaptiveRateLimiter } from './AdaptiveRateLimiter';
import { MigrationStateManager } from '../services/MigrationStateManager';
import { UploadWorker } from './UploadWorker';
import { DEFAULT_MIGRATION_CONFIG, MigrationConfig } from './types';
import { ISchedulerHandle, jobRegistry } from './JobRegistry';
import { prisma } from '../utils/database';

/** Worker stall threshold: abort a worker if it hasn't moved bytes for this long */
const WORKER_STALL_MS = 5 * 60 * 1000; // 5 minutes

/** Heartbeat log interval */
const HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds

/** Main scheduler loop tick rate */
const TICK_MS = 200;

/** Time without any queue/worker progress before deadlock recovery kicks in */
const DEADLOCK_TIMEOUT_MS = 60_000; // 60 seconds

/** Maximum retry count before a file is permanently marked FAILED */
const MAX_RETRIES = 5;

/**
 * FileScheduler
 *
 * Manages a pool of UploadWorkers and drives file transfers from the manifest queue.
 *
 * Key improvements over previous version:
 *  1. Implements ISchedulerHandle — registers with JobRegistry so WorkerWatchdog
 *     and the cancel endpoint can reach it without polling the DB
 *  2. retryJob() now calls stateManager.resetToQueued() BEFORE re-enqueueing,
 *     so the manifest item is visible to getPendingFiles() again
 *  3. abortStalledWorkers() — callable externally by WorkerWatchdog
 *  4. Dead workers are replaced immediately with a fresh worker
 *  5. Cancellation token — scheduler loop exits cleanly when cancelled
 *  6. lastProgressAt updated by all worker data events via UploadWorker.lastProgressAt
 */
export class FileScheduler implements ISchedulerHandle {
  public readonly jobId: string;
  private manifestId: string;
  private sourceDrive: drive_v3.Drive;
  private destDrive: drive_v3.Drive;
  private rateLimiter: AdaptiveRateLimiter;
  private stateManager: MigrationStateManager;
  private options: any;
  private folderCache: Map<string, string>;
  private config: MigrationConfig;

  private workers: UploadWorker[] = [];
  private buckets: Record<string, ManifestItem[]> = {
    TINY: [],
    SMALL: [],
    MEDIUM: [],
    LARGE: [],
    HUGE: []
  };

  private enqueuedFiles: Set<string> = new Set();
  private isDone: boolean = false;
  private isCancelled: boolean = false;
  private nextWorkerId: number = 1;

  // ISchedulerHandle implementation
  public isRunning: boolean = false;
  public lastProgressAt: number = Date.now();
  public get busyWorkerCount(): number {
    return this.workers.filter(w => w.isBusy).length;
  }

  constructor(
    jobId: string,
    manifestId: string,
    sourceDrive: drive_v3.Drive,
    destDrive: drive_v3.Drive,
    options: any,
    rateLimiter: AdaptiveRateLimiter,
    stateManager: MigrationStateManager,
    folderCache: Map<string, string>
  ) {
    this.jobId = jobId;
    this.manifestId = manifestId || jobId;
    this.sourceDrive = sourceDrive;
    this.destDrive = destDrive;
    this.options = options;
    this.rateLimiter = rateLimiter;
    this.stateManager = stateManager;
    this.folderCache = folderCache;
    this.config = { ...DEFAULT_MIGRATION_CONFIG, ...(options.performance || {}) };
    this.rateLimiter.setMaxConcurrency(this.config.maxUploadWorkers || 50);
  }

  // ── ISchedulerHandle implementation ──────────────────────────────────────────

  /** Signal the scheduler loop to stop (graceful — waits for current workers) */
  public cancel(): void {
    console.warn(`[FileScheduler] CANCEL_SIGNAL | JobId: ${this.jobId}`);
    this.isCancelled = true;
    this.isDone = true;
  }

  /** Abort ALL active workers — used by cancel endpoint */
  public async abortAll(reason?: string): Promise<void> {
    console.warn(
      `[FileScheduler] ABORT_ALL | JobId: ${this.jobId} | ` +
      `Workers: ${this.workers.length} | Reason: ${reason || 'unknown'}`
    );
    for (const worker of this.workers) {
      if (worker.isBusy) {
        worker.isDead = true;
        worker.abort(reason);
        // Reset their manifest item to QUEUED so it can be resumed later
        if (worker.currentItem) {
          await this.stateManager.resetToQueued(worker.currentItem.id).catch(e => {
            console.error(`[FileScheduler] resetToQueued failed for ${worker.currentItem?.id}: ${e.message}`);
          });
        }
      }
    }
    this.isDone = true;
  }

  /**
   * Abort workers that haven't made byte progress for stallThresholdMs.
   * Called by WorkerWatchdog on a schedule.
   */
  public async abortStalledWorkers(stallThresholdMs: number): Promise<void> {
    const now = Date.now();
    let abortedCount = 0;

    for (const worker of this.workers) {
      if (!worker.isBusy || worker.isDead) continue;

      const workerStalledMs = now - worker.lastProgressAt;
      if (workerStalledMs >= stallThresholdMs) {
        console.error(
          `[FileScheduler] WATCHDOG_ABORT | WorkerId: ${worker.id} | ` +
          `File: ${worker.currentFile} | StallDuration: ${Math.round(workerStalledMs / 1000)}s | ` +
          `BytesMoved: ${worker.uploadBytesTracked} | JobId: ${this.jobId}`
        );
        worker.isDead = true;
        worker.abort('watchdog stall recovery');

        if (worker.currentItem) {
          await this.stateManager.resetToQueued(worker.currentItem.id).catch(e => {
            console.error(`[FileScheduler] WATCHDOG_RESET_FAILED | ${worker.currentItem?.id}: ${e.message}`);
          });
          this.enqueuedFiles.delete(worker.currentItem.id);
        }
        abortedCount++;
      }
    }

    if (abortedCount > 0) {
      console.log(
        `[FileScheduler] WATCHDOG_RECOVERY | Aborted ${abortedCount} stalled workers | JobId: ${this.jobId}`
      );
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  private retryJob = async (item: ManifestItem): Promise<void> => {
    if (item.status === 'SUCCESS' || item.status === 'FAILED') return;

    try {
      const count = await ManifestStorage.incrementRetryCount(this.manifestId, item.id);

      if (count >= MAX_RETRIES) {
        console.error(
          `[FileScheduler] FILE_MAX_RETRY | File: ${item.name} | FileId: ${item.sourceId} | ` +
          `JobId: ${this.jobId} | Retries: ${count} | Marking FAILED.`
        );
        await this.stateManager.updateState(item.id, 'FAILED');
        const { saveCheckpoint } = await import('../utils/database');
        const destParentId = item.destParentId || this.folderCache.get(item.sourceParentId) || 'root';
        await saveCheckpoint(this.jobId, 'file', destParentId, item.sourceId, 'failed', {
          fileName: item.name,
          mimeType: item.mimeType,
          size: item.size,
          error: `Retry count exhausted after ${count} attempts`
        }).catch(() => {});
        this.enqueuedFiles.delete(item.id);
        return;
      }

      const delay = Math.min(30_000, Math.pow(2, count - 1) * 1000);
      console.log(
        `[FileScheduler] RETRY | File: ${item.name} | FileId: ${item.sourceId} | ` +
        `Attempt: ${count} | DelayMs: ${delay} | JobId: ${this.jobId}`
      );

      const { updateJobProgress } = await import('../utils/database');
      await updateJobProgress(this.jobId, {
        currentAction: `Retrying ${item.name} (Attempt ${count})`,
        currentFile: item.name
      }).catch(() => {});

      await this.stateManager.resetToQueued(item.id);
      this.enqueuedFiles.delete(item.id);

      setTimeout(() => {
        this.categorizeAndPush(item);
      }, delay);
    } catch (e: any) {
      console.error(
        `[FileScheduler] RETRY_ERROR | File: ${item.name} | Error: ${e.message}`
      );
      await this.stateManager.updateState(item.id, 'FAILED').catch(() => {});
      this.enqueuedFiles.delete(item.id);
    }
  };

  private categorizeAndPush(item: ManifestItem): boolean {
    if (this.enqueuedFiles.has(item.id)) return false;
    this.enqueuedFiles.add(item.id);
    const sz = item.size || 0;
    const MB = 1024 * 1024;
    if (sz < 1 * MB) this.buckets.TINY.push(item);
    else if (sz < 20 * MB) this.buckets.SMALL.push(item);
    else if (sz < 200 * MB) this.buckets.MEDIUM.push(item);
    else if (sz < 2000 * MB) this.buckets.LARGE.push(item);
    else this.buckets.HUGE.push(item);
    return true;
  }

  private spawnWorker(affinity: string): UploadWorker {
    const worker = new UploadWorker(
      this.nextWorkerId++,
      this.jobId,
      this.manifestId,
      this.sourceDrive,
      this.destDrive,
      this.rateLimiter,
      this.stateManager,
      this.options,
      this.folderCache,
      this.config
    );
    worker.affinity = affinity;
    this.workers.push(worker);
    console.log(
      `[FileScheduler] WORKER_SPAWN | WorkerId: ${worker.id} | Affinity: ${affinity} | ` +
      `TotalWorkers: ${this.workers.length} | JobId: ${this.jobId}`
    );
    return worker;
  }

  /** Check per-worker stall: if a worker has had no byte progress for WORKER_STALL_MS → abort it */
  private checkWorkerStalls(): void {
    const now = Date.now();
    for (const worker of this.workers) {
      if (!worker.isBusy || worker.isDead) continue;
      const stalledMs = now - worker.lastProgressAt;
      if (stalledMs >= WORKER_STALL_MS) {
        console.error(
          `[FileScheduler] WORKER_STALL_DETECTED | WorkerId: ${worker.id} | ` +
          `File: ${worker.currentFile} | StallDuration: ${Math.round(stalledMs / 1000)}s | ` +
          `BytesMoved: ${worker.uploadBytesTracked} | JobId: ${this.jobId} | Aborting.`
        );
        worker.isDead = true;
        worker.abort('scheduler stall detection');

        // Reset manifest state so this file re-enters the QUEUED pool
        if (worker.currentItem) {
          this.stateManager.resetToQueued(worker.currentItem.id).catch(e => {
            console.error(`[FileScheduler] resetToQueued error: ${e.message}`);
          });
          this.enqueuedFiles.delete(worker.currentItem.id);
        }
      }

      // Update scheduler-level lastProgressAt from worker's lastProgressAt
      if (worker.lastProgressAt > this.lastProgressAt) {
        this.lastProgressAt = worker.lastProgressAt;
      }
    }
  }

  private emitHeartbeat(totalPending: number): void {
    const busy = this.workers.filter(w => w.isBusy);
    const idle = this.workers.filter(w => w.isIdle);
    const dead = this.workers.filter(w => w.isDead);
    console.log(
      `\n[FileScheduler] HEARTBEAT | JobId: ${this.jobId} | ` +
      `QueueLength: ${totalPending} | ` +
      `Busy: ${busy.length} | Idle: ${idle.length} | Dead: ${dead.length} | ` +
      `TotalWorkers: ${this.workers.length} | ` +
      `Stalled: ${this.stateManager.isStalled} | ` +
      `Timestamp: ${new Date().toISOString()}`
    );
    for (const w of busy) {
      const stalledSec = Math.round((Date.now() - w.lastProgressAt) / 1000);
      console.log(
        `  [Worker ${w.id}] ALIVE | File: ${w.currentFile} | ` +
        `BytesMoved: ${w.uploadBytesTracked} | ` +
        `Elapsed: ${Math.round((Date.now() - w.startedAt) / 1000)}s | ` +
        `StallSec: ${stalledSec}`
      );
    }
  }

  // ── Main run loop ─────────────────────────────────────────────────────────────

  public async run(): Promise<void> {
    this.isRunning = true;
    this.lastProgressAt = Date.now();

    // Register with the global job registry so the watchdog and cancel endpoint can reach us
    jobRegistry.register(this.jobId, this);

    console.log(
      `\n[FileScheduler] QUEUE_CREATED | JobId: ${this.jobId} | ManifestId: ${this.manifestId} | ` +
      `Timestamp: ${new Date().toISOString()}`
    );

    try {
      const totalFiles = await ManifestStorage.countItems(this.manifestId, { isFolder: false });
      const queuedFiles = await ManifestStorage.countItems(this.manifestId, { isFolder: false, status: 'QUEUED' });

      console.log(
        `[FileScheduler] QUEUE_SIZE | TotalFiles: ${totalFiles} | QueuedFiles: ${queuedFiles} | ` +
        `JobId: ${this.jobId}`
      );

      if (totalFiles > 0 && queuedFiles === 0) {
        // Pre-init: ensure PENDING files are queued
        const pendingFolders = await ManifestStorage.countItems(this.manifestId, {
          isFolder: true,
          statusIn: ['PENDING', 'QUEUED', 'UPLOADING', 'VERIFYING']
        });
        if (pendingFolders === 0) {
          console.warn(
            `[FileScheduler] QUEUE_EMPTY_PREINIT | Pre-queuing remaining PENDING files. ` +
            `JobId: ${this.jobId}`
          );
          await ManifestStorage.updateManyStatus(
            this.manifestId,
            { isFolder: false, statusIn: ['PENDING'] },
            'QUEUED'
          );
        }
      }

      let deadlockTimer = 0;
      let lastHeartbeat = Date.now();

      const getLimit = (bucket: string) => {
        const total = this.rateLimiter.getConcurrency();
        if (bucket === 'HUGE') return Math.max(1, Math.min(2, total));
        if (bucket === 'LARGE') return Math.max(2, Math.min(4, total));
        return Math.max(1, total);
      };

      while (!this.isDone && !this.isCancelled) {
        const now = Date.now();

        // ── Heartbeat ─────────────────────────────────────────────────────────
        if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
          const totalPending = Object.values(this.buckets).reduce((acc, b) => acc + b.length, 0);
          this.emitHeartbeat(totalPending);
          lastHeartbeat = now;
        }

        // ── Per-worker stall check ─────────────────────────────────────────────
        this.checkWorkerStalls();

        // ── Reap dead workers, spawn replacements ─────────────────────────────
        const deadWorkers = this.workers.filter(w => w.isDead);
        if (deadWorkers.length > 0) {
          console.warn(
            `[FileScheduler] WORKER_REAP | Removing ${deadWorkers.length} dead workers | ` +
            `JobId: ${this.jobId}`
          );
          this.workers = this.workers.filter(w => !w.isDead);
        }

        // ── Replenish bucket from DB ───────────────────────────────────────────
        const totalPending = Object.values(this.buckets).reduce((acc, b) => acc + b.length, 0);
        if (totalPending < this.rateLimiter.getConcurrency() * 2) {
          const items = await ManifestStorage.getPendingFiles(this.manifestId, 500);
          let added = 0;
          for (const item of items) {
            if (this.categorizeAndPush(item)) added++;
          }
          if (added > 0) {
            this.lastProgressAt = Date.now(); // New items = progress
            console.log(
              `[FileScheduler] QUEUE_REPLENISH | Added: ${added} | JobId: ${this.jobId}`
            );
          }
        }

        // ── Assign work to idle workers ────────────────────────────────────────
        const idleWorkers = this.workers.filter(w => w.isIdle);
        for (const worker of idleWorkers) {
          let selectedItem = this.buckets[worker.affinity]?.shift();
          if (!selectedItem) {
            for (const key of ['TINY', 'SMALL', 'MEDIUM', 'LARGE', 'HUGE']) {
              selectedItem = this.buckets[key]?.shift();
              if (selectedItem) {
                worker.affinity = key;
                break;
              }
            }
          }
          if (selectedItem) {
            console.log(
              `[FileScheduler] WORKER_ASSIGN | WorkerId: ${worker.id} | ` +
              `File: ${selectedItem.name} | FileId: ${selectedItem.sourceId} | ` +
              `Bucket: ${worker.affinity} | JobId: ${this.jobId}`
            );
            // Fire-and-forget: worker manages its own lifecycle via releaseWorker
            worker.processFile(
              selectedItem,
              (_workerId) => { /* worker already manages isBusy */ },
              this.retryJob
            );
          }
        }

        // ── Spawn new workers ──────────────────────────────────────────────────
        for (const key of ['TINY', 'SMALL', 'MEDIUM', 'LARGE', 'HUGE']) {
          const activeInBucket = this.workers.filter(w => !w.isIdle && !w.isDead && w.affinity === key).length;
          if (
            activeInBucket < getLimit(key) &&
            this.buckets[key].length > 0 &&
            this.workers.length < this.rateLimiter.getConcurrency()
          ) {
            this.spawnWorker(key);
          }
        }

        // ── Termination check ──────────────────────────────────────────────────
        const busyCount = this.workers.filter(w => !w.isIdle && !w.isDead).length;
        const currentPending = Object.values(this.buckets).reduce((acc, b) => acc + b.length, 0);

        if (currentPending === 0 && busyCount === 0) {
          const unresolvedCount = await ManifestStorage.countItems(this.manifestId, {
            statusIn: ['PENDING', 'QUEUED', 'UPLOADING', 'VERIFYING']
          });

          if (unresolvedCount === 0) {
            const pendingWrites = this.stateManager.getPendingWriteCount();
            if (pendingWrites === 0) {
              this.isDone = true;
              console.log(
                `[FileScheduler] QUEUE_FINISHED | JobId: ${this.jobId} | ` +
                `Timestamp: ${new Date().toISOString()}`
              );
              await this.stateManager.finalizeMigration(busyCount, currentPending);
              break;
            } else {
              console.log(
                `[FileScheduler] WAITING_DB_WRITES | PendingWrites: ${pendingWrites} | ` +
                `JobId: ${this.jobId}`
              );
            }
          } else {
            deadlockTimer += TICK_MS;

            if (deadlockTimer === TICK_MS || deadlockTimer % 10_000 === 0) {
              const unresolvedItems = await ManifestStorage.getUnresolvedItems(this.manifestId, 100);

              console.warn(
                `[FileScheduler] DEADLOCK_AUDIT | UnresolvedCount: ${unresolvedCount} | ` +
                `Timer: ${deadlockTimer}ms | JobId: ${this.jobId}`
              );
              for (const item of unresolvedItems) {
                console.warn(
                  `  - ID: ${item.id} | Name: ${item.name} | ` +
                  `isFolder: ${item.isFolder} | Status: ${item.status} | ` +
                  `ParentId: ${item.sourceParentId}`
                );
              }

              // Auto-recover UPLOADING/VERIFYING stuck items (no active workers)
              const stuckItems = unresolvedItems.filter(
                i => i.status === 'UPLOADING' || i.status === 'VERIFYING'
              );
              if (stuckItems.length > 0 && busyCount === 0) {
                console.warn(
                  `[FileScheduler] DEADLOCK_RECOVERY | Moving ${stuckItems.length} stuck ` +
                  `UPLOADING/VERIFYING items back to QUEUED | JobId: ${this.jobId}`
                );
                await ManifestStorage.updateManyStatus(
                  this.manifestId,
                  { statusIn: ['UPLOADING', 'VERIFYING'] },
                  'QUEUED'
                );
                for (const item of stuckItems) {
                  this.enqueuedFiles.delete(item.id);
                }
                deadlockTimer = 0;
              }
            }

            if (deadlockTimer >= DEADLOCK_TIMEOUT_MS) {
              throw new Error(
                `FileScheduler Deadlock: ${unresolvedCount} items unresolved in DB ` +
                `but queue and workers are empty. JobId: ${this.jobId}`
              );
            }
          }
        } else {
          deadlockTimer = 0;
        }

        await new Promise(r => setTimeout(r, TICK_MS));
      }

      console.log(
        `[FileScheduler] WORKER_EXIT | JobId: ${this.jobId} | ` +
        `Cancelled: ${this.isCancelled} | Timestamp: ${new Date().toISOString()}`
      );
    } finally {
      this.isRunning = false;
      // Always deregister from JobRegistry so the watchdog doesn't keep checking it
      jobRegistry.deregister(this.jobId);
    }
  }
}
