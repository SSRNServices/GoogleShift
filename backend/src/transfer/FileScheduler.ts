// @ts-nocheck
import { drive_v3 } from 'googleapis';
import { ManifestStorage, ManifestItem } from '../utils/ManifestStorage';
import { AdaptiveRateLimiter } from './AdaptiveRateLimiter';
import { MigrationStateManager } from '../services/MigrationStateManager';
import { UploadWorker } from './UploadWorker';
import { DEFAULT_MIGRATION_CONFIG, MigrationConfig } from './types';

/** If a worker's uploadBytesTracked doesn't increase for this long → force-abort it */
const WORKER_STALL_MS = 5 * 60 * 1000; // 5 minutes

/** Heartbeat log interval */
const HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds

/** Main scheduler loop tick rate */
const TICK_MS = 100;

/** How long to wait for a deadlocked DB state before throwing */
const DEADLOCK_TIMEOUT_MS = 30 * 1000; // 30 seconds

export class FileScheduler {
  private jobId: string;
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
  private nextWorkerId: number = 1;

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
    this.manifestId = manifestId;
    this.sourceDrive = sourceDrive;
    this.destDrive = destDrive;
    this.options = options;
    this.rateLimiter = rateLimiter;
    this.stateManager = stateManager;
    this.folderCache = folderCache;
    this.config = { ...DEFAULT_MIGRATION_CONFIG, ...(options.performance || {}) };
    this.rateLimiter.setMaxConcurrency(this.config.maxUploadWorkers || 50);
  }

  private releaseWorker = (_workerId: number) => {};

  private retryJob = async (item: ManifestItem) => {
    if (item.status === 'SUCCESS' || item.status === 'FAILED') return;
    const count = await ManifestStorage.incrementRetryCount(this.manifestId, item.id);
    if (count >= 5) {
      console.error(
        `[FileScheduler] FILE_MAX_RETRY | File: ${item.name} | FileId: ${item.sourceId} | ` +
        `JobId: ${this.jobId} | Retries: ${count} | Marking FAILED.`
      );
      await this.stateManager.updateState(item.id, 'FAILED');
    } else {
      const delay = Math.pow(2, count - 1) * 1000;
      console.log(
        `[FileScheduler] RETRY | File: ${item.name} | FileId: ${item.sourceId} | ` +
        `Attempt: ${count} | DelayMs: ${delay}`
      );
      // Remove from enqueued set so it can be re-categorized
      this.enqueuedFiles.delete(item.id);
      setTimeout(() => {
        this.categorizeAndPush(item);
      }, delay);
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

  /** Per-worker stall detection: if uploadBytesTracked doesn't advance for WORKER_STALL_MS, abort */
  private checkWorkerStalls() {
    const now = Date.now();
    for (const worker of this.workers) {
      if (!worker.isBusy || worker.isDead) continue;
      const elapsed = now - worker.startedAt;
      if (elapsed < WORKER_STALL_MS) continue;

      // Check if upload bytes have changed since last stall check
      const bytesSinceStart = worker.uploadBytesTracked;
      const stallElapsed = now - (worker.lastUploadCheckTime || worker.startedAt);

      if (bytesSinceStart === worker.lastUploadBytes && stallElapsed >= WORKER_STALL_MS) {
        console.error(
          `[FileScheduler] WORKER_STALL_DETECTED | WorkerId: ${worker.id} | ` +
          `File: ${worker.currentFile} | Elapsed: ${elapsed}ms | ` +
          `UploadBytes: ${bytesSinceStart} | JobId: ${this.jobId} | Aborting worker.`
        );
        worker.isDead = true;
        worker.abort();
      } else if (bytesSinceStart !== worker.lastUploadBytes) {
        worker.lastUploadBytes = bytesSinceStart;
        worker.lastUploadCheckTime = now;
      }
    }
  }

  /** Heartbeat: log full queue/worker state every 30 seconds */
  private emitHeartbeat(totalPending: number) {
    const busyWorkers = this.workers.filter(w => w.isBusy);
    const idleWorkers = this.workers.filter(w => w.isIdle);
    console.log(
      `\n[FileScheduler] HEARTBEAT | JobId: ${this.jobId} | ` +
      `QueueLength: ${totalPending} | ` +
      `ActiveWorkers: ${busyWorkers.length} | ` +
      `IdleWorkers: ${idleWorkers.length} | ` +
      `TotalWorkers: ${this.workers.length} | ` +
      `Timestamp: ${new Date().toISOString()}`
    );
    for (const worker of busyWorkers) {
      console.log(
        `  [Worker ${worker.id}] ALIVE | File: ${worker.currentFile} | ` +
        `UploadBytes: ${worker.uploadBytesTracked} | ` +
        `Elapsed: ${Date.now() - worker.startedAt}ms`
      );
    }
  }

  public async run() {
    console.log(
      `\n[FileScheduler] QUEUE_CREATED | JobId: ${this.jobId} | ManifestId: ${this.manifestId} | ` +
      `Timestamp: ${new Date().toISOString()}`
    );

    const { prisma } = await import('../utils/database');
    const totalFiles = await prisma.migrationManifest.count({
      where: { jobId: this.manifestId, isFolder: false }
    });
    const queuedFiles = await prisma.migrationManifest.count({
      where: { jobId: this.manifestId, isFolder: false, status: 'QUEUED' }
    });

    console.log(
      `[FileScheduler] QUEUE_SIZE | TotalFiles: ${totalFiles} | QueuedFiles: ${queuedFiles} | ` +
      `JobId: ${this.jobId}`
    );

    // Ensure files are in QUEUED state
    if (totalFiles > 0) {
      const pendingFolders = await prisma.migrationManifest.count({
        where: {
          jobId: this.manifestId,
          isFolder: true,
          status: { notIn: ['SUCCESS', 'FAILED'] }
        }
      });
      if (queuedFiles === 0 && pendingFolders === 0) {
        console.warn(
          `[FileScheduler] QUEUE_EMPTY_PREINIT | Pre-queuing remaining pending files. ` +
          `JobId: ${this.jobId}`
        );
        await prisma.migrationManifest.updateMany({
          where: { jobId: this.manifestId, isFolder: false, status: 'PENDING' },
          data: { status: 'QUEUED' }
        });
      }
    }

    console.log(
      `[FileScheduler] COPY_START | JobId: ${this.jobId} | ManifestId: ${this.manifestId} | ` +
      `Timestamp: ${new Date().toISOString()}`
    );

    let deadlockTimer = 0;
    let lastHeartbeat = Date.now();

    const getLimit = (bucket: string) => {
      const total = this.rateLimiter.getConcurrency();
      if (bucket === 'HUGE') return 1;
      return Math.max(1, total);
    };

    while (!this.isDone) {
      const now = Date.now();

      // ── Heartbeat ────────────────────────────────────────────────────────────
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        const totalPending = Object.values(this.buckets).reduce((acc, b) => acc + b.length, 0);
        this.emitHeartbeat(totalPending);
        lastHeartbeat = now;
      }

      // ── Per-worker stall check ────────────────────────────────────────────────
      this.checkWorkerStalls();

      // ── Remove dead workers ───────────────────────────────────────────────────
      const deadCount = this.workers.filter(w => w.isDead).length;
      if (deadCount > 0) {
        console.warn(
          `[FileScheduler] WORKER_REAP | Removing ${deadCount} dead workers | ` +
          `JobId: ${this.jobId}`
        );
        this.workers = this.workers.filter(w => !w.isDead);
      }

      // ── Replenish bucket from DB ──────────────────────────────────────────────
      const totalPending = Object.values(this.buckets).reduce((acc, b) => acc + b.length, 0);
      if (totalPending < this.rateLimiter.getConcurrency() * 2) {
        const items = await ManifestStorage.getPendingFiles(this.manifestId, 500);
        let added = 0;
        for (const item of items) {
          if (this.categorizeAndPush(item)) added++;
        }
        if (added > 0) {
          console.log(
            `[FileScheduler] QUEUE_REPLENISH | Added: ${added} | JobId: ${this.jobId}`
          );
        }
      }

      // ── Assign work to idle workers ───────────────────────────────────────────
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
          worker.processFile(selectedItem, this.releaseWorker, this.retryJob);
        }
      }

      // ── Spawn new workers ─────────────────────────────────────────────────────
      const bucketKeys = ['TINY', 'SMALL', 'MEDIUM', 'LARGE', 'HUGE'];
      for (const key of bucketKeys) {
        const activeInBucket = this.workers.filter(w => !w.isIdle && w.affinity === key).length;
        if (
          activeInBucket < getLimit(key) &&
          this.buckets[key].length > 0 &&
          this.workers.length < this.rateLimiter.getConcurrency()
        ) {
          this.spawnWorker(key);
        }
      }

      // ── Termination check ─────────────────────────────────────────────────────
      const busyWorkersCount = this.workers.filter(w => !w.isIdle).length;
      const currentTotalPending = Object.values(this.buckets).reduce((acc, b) => acc + b.length, 0);

      if (currentTotalPending === 0 && busyWorkersCount === 0) {
        const { prisma: db } = await import('../utils/database');
        const unresolvedCount = await db.migrationManifest.count({
          where: {
            jobId: this.manifestId,
            status: { in: ['PENDING', 'QUEUED', 'UPLOADING', 'VERIFYING'] }
          }
        });

        if (unresolvedCount === 0) {
          const pendingWrites = this.stateManager.getPendingWriteCount();
          if (pendingWrites === 0) {
            this.isDone = true;
            console.log(
              `[FileScheduler] QUEUE_FINISHED | JobId: ${this.jobId} | ` +
              `Timestamp: ${new Date().toISOString()}`
            );
            await this.stateManager.finalizeMigration(busyWorkersCount, currentTotalPending);
            break;
          } else {
            console.log(
              `[FileScheduler] WAITING_DB_WRITES | PendingWrites: ${pendingWrites} | ` +
              `JobId: ${this.jobId}`
            );
          }
        } else {
          deadlockTimer += TICK_MS;

          if (deadlockTimer === TICK_MS || deadlockTimer % 5000 === 0) {
            const unresolvedItems = await db.migrationManifest.findMany({
              where: {
                jobId: this.manifestId,
                status: { in: ['PENDING', 'QUEUED', 'UPLOADING', 'VERIFYING'] }
              },
              select: { id: true, name: true, isFolder: true, status: true, sourceParentId: true }
            });
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

            // Auto-recover UPLOADING items that are stuck (no active workers)
            const stuckUploading = unresolvedItems.filter(
              i => i.status === 'UPLOADING' || i.status === 'VERIFYING'
            );
            if (stuckUploading.length > 0) {
              console.warn(
                `[FileScheduler] DEADLOCK_RECOVERY | Moving ${stuckUploading.length} stuck ` +
                `UPLOADING/VERIFYING items back to QUEUED | JobId: ${this.jobId}`
              );
              await db.migrationManifest.updateMany({
                where: {
                  jobId: this.manifestId,
                  status: { in: ['UPLOADING', 'VERIFYING'] }
                },
                data: { status: 'QUEUED' }
              });
              // Clear enqueued set so these can be re-picked
              for (const item of stuckUploading) {
                this.enqueuedFiles.delete(item.id);
              }
              deadlockTimer = 0;
            }
          }

          if (deadlockTimer > DEADLOCK_TIMEOUT_MS) {
            const unresolvedItems = await db.migrationManifest.findMany({
              where: {
                jobId: this.manifestId,
                status: { in: ['PENDING', 'QUEUED', 'UPLOADING', 'VERIFYING'] }
              }
            });
            console.error(
              `\n[FileScheduler] FATAL_DEADLOCK | JobId: ${this.jobId} | ` +
              `UnresolvedCount: ${unresolvedCount} | Dumping state:`
            );
            for (const item of unresolvedItems) {
              console.error(
                `  - ID: ${item.id} | Name: ${item.name} | ` +
                `Status: ${item.status} | isFolder: ${item.isFolder}`
              );
            }
            throw new Error(
              `FileScheduler Deadlock: ${unresolvedCount} items unresolved in DB but queue empty. JobId: ${this.jobId}`
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
      `Timestamp: ${new Date().toISOString()}`
    );
  }
}
