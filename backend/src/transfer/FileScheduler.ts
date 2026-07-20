import { drive_v3 } from 'googleapis';
import { ManifestStorage } from '../utils/ManifestStorage';
import { AdaptiveRateLimiter } from './AdaptiveRateLimiter';
import { ProgressAggregator } from './ProgressAggregator';
import { UploadWorker } from './UploadWorker';

export class FileScheduler {
  private jobId: string;
  private sourceDrive: drive_v3.Drive;
  private destDrive: drive_v3.Drive;
  private rateLimiter: AdaptiveRateLimiter;
  private progress: ProgressAggregator;
  private options: any;
  private folderCache: Map<string, string>;
  private workers: UploadWorker[] = [];

  constructor(jobId: string, sourceDrive: drive_v3.Drive, destDrive: drive_v3.Drive, options: any, rateLimiter: AdaptiveRateLimiter, progress: ProgressAggregator, folderCache: Map<string, string>) {
    this.jobId = jobId;
    this.sourceDrive = sourceDrive;
    this.destDrive = destDrive;
    this.options = options;
    this.rateLimiter = rateLimiter;
    this.progress = progress;
    this.folderCache = folderCache;
  }

  public async run() {
    console.log(`[FileScheduler] Starting file transfers...`);

    // Create the max possible workers, but we will only dispatch up to the current rate limit
    for (let i = 0; i < 20; i++) {
      this.workers.push(new UploadWorker(i + 1, this.jobId, this.sourceDrive, this.destDrive, this.rateLimiter, this.progress, this.options, this.folderCache));
    }

    let isDone = false;
    let pendingCount = -1;

    // Queue Watcher
    const queueWatcher = async () => {
      while (!isDone) {
        const stats = this.progress.getMetrics();
        console.log(`[QUEUE] Pending Files: ${stats.totalFiles - stats.completedFiles - stats.failedFiles} | Running: ${stats.busyWorkers} | Completed: ${stats.completedFiles} | Failed: ${stats.failedFiles} | Retries: ${stats.retryCount} | Queue Length: ${stats.queueLength}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    };
    queueWatcher();

    while (!isDone) {
      // Get concurrency limit
      const maxConcurrency = this.rateLimiter.getConcurrency();
      
      // Update worker stats
      const idleWorkers = this.workers.filter(w => w.isIdle);
      const busyWorkersCount = 20 - idleWorkers.length;
      
      // Update progress
      this.progress.reportProgress({
        currentWorkers: maxConcurrency,
        idleWorkers: Math.max(0, maxConcurrency - busyWorkersCount),
        busyWorkers: busyWorkersCount
      });

      // If we have available concurrency
      if (busyWorkersCount < maxConcurrency) {
         // Fetch batch of files
         const needed = maxConcurrency - busyWorkersCount;
         const items = await ManifestStorage.getPendingFiles(this.jobId, needed);
         
         if (items.length === 0 && busyWorkersCount === 0) {
            isDone = true;
            break;
         }

         this.progress.reportProgress({ queueLength: items.length }); // roughly

         for (const item of items) {
           const idleWorker = this.workers.find(w => w.isIdle);
           if (idleWorker) {
              // We don't await this, it runs in background
              idleWorker.processFile(item);
           }
         }
      }

      // Small sleep before next polling
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[FileScheduler] File transfers complete.`);
    isDone = true; // ensure queueWatcher exits
  }
}
