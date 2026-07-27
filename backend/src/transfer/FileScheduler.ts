// @ts-nocheck
import { drive_v3 } from 'googleapis';
import { ManifestStorage, ManifestItem } from '../utils/ManifestStorage';
import { AdaptiveRateLimiter } from './AdaptiveRateLimiter';
import { MigrationStateManager } from '../services/MigrationStateManager';
import { UploadWorker } from './UploadWorker';
import { DEFAULT_MIGRATION_CONFIG, MigrationConfig } from './types';
import os from 'os';

export class FileScheduler {
  private jobId: string;
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

  constructor(jobId: string, sourceDrive: drive_v3.Drive, destDrive: drive_v3.Drive, options: any, rateLimiter: AdaptiveRateLimiter, stateManager: MigrationStateManager, folderCache: Map<string, string>) {
    this.jobId = jobId;
    this.sourceDrive = sourceDrive;
    this.destDrive = destDrive;
    this.options = options;
    this.rateLimiter = rateLimiter;
    this.stateManager = stateManager;
    this.folderCache = folderCache;
    this.config = { ...DEFAULT_MIGRATION_CONFIG, ...(options.performance || {}) };
    
    this.rateLimiter.setMaxConcurrency(this.config.maxUploadWorkers || 50);
  }

  private releaseWorker = (workerId: number) => {};

  private retryJob = async (item: ManifestItem) => {
    if (item.status === 'SUCCESS' || item.status === 'FAILED') return;
    const count = await ManifestStorage.incrementRetryCount(this.jobId, item.id);
    if (count >= 5) {
      console.log(`[FileScheduler] Max retries reached for ${item.name}. Marking FAILED.`);
      await this.stateManager.updateState(item.id, 'FAILED');
    } else {
      const delay = Math.pow(2, count - 1) * 1000;
      console.log(`[FileScheduler] Requeueing item: ${item.name} in ${delay}ms (Retry ${count})`);
      setTimeout(() => {
         this.categorizeAndPush(item);
      }, delay);
    }
  };

  private categorizeAndPush(item: ManifestItem) {
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

  private async watchdog() {
    while (!this.isDone) {
      await new Promise(r => setTimeout(r, 10000));
      if (this.isDone) break;
      const now = Date.now();
      for (const worker of this.workers) {
        if (worker.isBusy && !worker.isDead) {
          if (now - worker.lastActivity > 120000) {
             console.log(`[WATCHDOG] Worker ${worker.id} stalled on ${worker.currentFile}. Cancelling.`);
             worker.isDead = true;
             worker.abort();
             // Note: worker's catch block will handle the retry when abort throws
          }
        }
      }
      this.workers = this.workers.filter(w => !w.isDead);
    }
  }

  private spawnWorker(affinity: string) {
    const worker = new UploadWorker(this.nextWorkerId++, this.jobId, this.sourceDrive, this.destDrive, this.rateLimiter, this.stateManager, this.options, this.folderCache, this.config);
    worker.affinity = affinity;
    this.workers.push(worker);
  }

  public async run() {
    console.log(`[FileScheduler] Starting bucketing scheduler...`);

    const { prisma } = await import('../utils/database');
    const totalFiles = await prisma.migrationManifest.count({
       where: { jobId: this.jobId, isFolder: false }
    });
    const queuedFiles = await prisma.migrationManifest.count({
       where: { jobId: this.jobId, isFolder: false, status: 'QUEUED' }
    });
    
    if (totalFiles > 0) {
       const pendingFolders = await prisma.migrationManifest.count({
          where: { jobId: this.jobId, isFolder: true, status: { notIn: ['SUCCESS', 'FAILED'] } }
       });
       if (queuedFiles === 0 && pendingFolders === 0) {
          throw new Error(`[FATAL] Queue size is zero but manifest contains files and no folders pending.`);
       }
    }

    this.watchdog();

    let deadlockTimer = 0;
    
    // Scale buckets limits based on max concurrency
    const getLimit = (bucket: string) => {
       const total = this.rateLimiter.getConcurrency();
       if (bucket === 'HUGE') return 1;
       if (bucket === 'LARGE') return Math.max(1, Math.floor(total * 0.1));
       if (bucket === 'MEDIUM') return Math.max(1, Math.floor(total * 0.2));
       if (bucket === 'SMALL') return Math.max(1, Math.floor(total * 0.3));
       return Math.max(1, Math.floor(total * 0.4)); // TINY
    };

    while (!this.isDone) {
      // Replenish DB Items
      const totalPending = Object.values(this.buckets).reduce((acc, b) => acc + b.length, 0);
      if (totalPending < this.rateLimiter.getConcurrency() * 2) {
         const items = await ManifestStorage.getPendingFiles(this.jobId, 500);
         for (const item of items) {
           this.categorizeAndPush(item);
         }
      }

      // Assign files to existing idle workers
      const idleWorkers = this.workers.filter(w => w.isIdle);
      for (const worker of idleWorkers) {
         let selectedItem = this.buckets[worker.affinity]?.shift();
         if (!selectedItem) {
            // Steal work if affinity bucket is empty
            for (const key of ['TINY', 'SMALL', 'MEDIUM', 'LARGE', 'HUGE']) {
               selectedItem = this.buckets[key]?.shift();
               if (selectedItem) {
                 worker.affinity = key; // change affinity
                 break;
               }
            }
         }
         if (selectedItem) worker.processFile(selectedItem, this.releaseWorker, this.retryJob);
      }

      // Spawn new workers if under limits
      const bucketKeys = ['TINY', 'SMALL', 'MEDIUM', 'LARGE', 'HUGE'];
      for (const key of bucketKeys) {
         const activeInBucket = this.workers.filter(w => !w.isIdle && w.affinity === key).length;
         if (activeInBucket < getLimit(key) && this.buckets[key].length > 0 && this.workers.length < this.rateLimiter.getConcurrency()) {
            this.spawnWorker(key);
         }
      }
      
      const busyWorkersCount = this.workers.filter(w => !w.isIdle).length;
      const currentTotalPending = Object.values(this.buckets).reduce((acc, b) => acc + b.length, 0);

      if (currentTotalPending === 0 && busyWorkersCount === 0) {
         const { prisma } = await import('../utils/database');
         const unresolvedCount = await prisma.migrationManifest.count({
            where: {
               jobId: this.jobId,
               status: { in: ['PENDING', 'QUEUED', 'UPLOADING', 'VERIFYING'] }
            }
         });

         if (unresolvedCount === 0) {
            const pendingWrites = this.stateManager.getPendingWriteCount();
            if (pendingWrites === 0) {
               this.isDone = true;
               await this.stateManager.finalizeMigration(busyWorkersCount, currentTotalPending);
               break;
            }
         } else {
            deadlockTimer += 50;
            if (deadlockTimer > 30000) {
               throw new Error(`FileScheduler Deadlock: ${unresolvedCount} items unresolved in DB but queue empty.`);
            }
         }
      } else {
         deadlockTimer = 0;
      }

      await new Promise(r => setTimeout(r, 50));
    }
  }
}
