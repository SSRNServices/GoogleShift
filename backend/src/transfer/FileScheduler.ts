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

  constructor(jobId: string, manifestId: string, sourceDrive: drive_v3.Drive, destDrive: drive_v3.Drive, options: any, rateLimiter: AdaptiveRateLimiter, stateManager: MigrationStateManager, folderCache: Map<string, string>) {
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

  private releaseWorker = (workerId: number) => {};

  private retryJob = async (item: ManifestItem) => {
    if (item.status === 'SUCCESS' || item.status === 'FAILED') return;
    const count = await ManifestStorage.incrementRetryCount(this.manifestId, item.id);
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
      await new Promise(r => setTimeout(r, 5000));
      if (this.isDone) break;
      const now = Date.now();
      for (const worker of this.workers) {
        if (worker.isBusy && !worker.isDead) {
          if (now - worker.lastActivity > 30000) {
             console.log(`[WATCHDOG] Worker ${worker.id} stalled for 30s on ${worker.currentFile}. Cancelling.`);
             worker.isDead = true;
             worker.abort();
          }
        }
      }
      this.workers = this.workers.filter(w => !w.isDead);
    }
  }

  private spawnWorker(affinity: string) {
    const worker = new UploadWorker(this.nextWorkerId++, this.jobId, this.manifestId, this.sourceDrive, this.destDrive, this.rateLimiter, this.stateManager, this.options, this.folderCache, this.config);
    worker.affinity = affinity;
    this.workers.push(worker);
    console.log(`[FileScheduler] Spawned worker ${worker.id} with affinity ${affinity}. Total workers: ${this.workers.length}`);
  }

  public async run() {
    console.log(`[FileScheduler] Starting bucketing scheduler for Job ${this.jobId} and Manifest ${this.manifestId}...`);

    const { prisma } = await import('../utils/database');
    const totalFiles = await prisma.migrationManifest.count({
       where: { jobId: this.manifestId, isFolder: false }
    });
    const queuedFiles = await prisma.migrationManifest.count({
       where: { jobId: this.manifestId, isFolder: false, status: 'QUEUED' }
    });
    
    console.log(`[FileScheduler Diagnostic] Total Files in Manifest: ${totalFiles} | Queued Files: ${queuedFiles}`);

    if (totalFiles > 0) {
       const pendingFolders = await prisma.migrationManifest.count({
          where: { jobId: this.manifestId, isFolder: true, status: { notIn: ['SUCCESS', 'FAILED'] } }
       });
       if (queuedFiles === 0 && pendingFolders === 0) {
          console.warn(`[FileScheduler Warning] Queue size is zero. Pre-queuing remaining pending files.`);
          await prisma.migrationManifest.updateMany({
             where: { jobId: this.manifestId, isFolder: false, status: 'PENDING' },
             data: { status: 'QUEUED' }
          });
       }
    }

    this.watchdog();

    let deadlockTimer = 0;
    
    // Scale buckets limits based on max concurrency
    const getLimit = (bucket: string) => {
       const total = this.rateLimiter.getConcurrency();
       if (bucket === 'HUGE') return 1;
       return Math.max(1, total);
    };

    while (!this.isDone) {
      // Replenish DB Items
      const totalPending = Object.values(this.buckets).reduce((acc, b) => acc + b.length, 0);
      if (totalPending < this.rateLimiter.getConcurrency() * 2) {
         const items = await ManifestStorage.getPendingFiles(this.manifestId, 500);
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
               jobId: this.manifestId,
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
            if (deadlockTimer === 50 || deadlockTimer % 5000 === 0) {
               const unresolvedItems = await prisma.migrationManifest.findMany({
                  where: {
                     jobId: this.manifestId,
                     status: { in: ['PENDING', 'QUEUED', 'UPLOADING', 'VERIFYING'] }
                  }
               });
               console.warn(`[FileScheduler Warning] ${unresolvedCount} unresolved items in DB (Timer: ${deadlockTimer}ms):`);
               for (const item of unresolvedItems) {
                  console.warn(`  - ID: ${item.id} | Name: ${item.name} | isFolder: ${item.isFolder} | status: ${item.status} | sourceParentId: ${item.sourceParentId}`);
               }
            }

            if (deadlockTimer > 15000) {
               const unresolvedItems = await prisma.migrationManifest.findMany({
                  where: {
                     jobId: this.manifestId,
                     status: { in: ['PENDING', 'QUEUED', 'UPLOADING', 'VERIFYING'] }
                  }
               });
               console.error(`\n=================== FATAL DEADLOCK AUDIT DUMP ===================`);
               console.error(`Job ID: ${this.jobId} | Manifest ID: ${this.manifestId} | Unresolved Count: ${unresolvedCount}`);
               for (const item of unresolvedItems) {
                  console.error(`  - ID: ${item.id} | Name: ${item.name} | isFolder: ${item.isFolder} | status: ${item.status} | sourceParentId: ${item.sourceParentId}`);
               }
               console.error(`=================================================================\n`);
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
