import { updateJobProgress, logJobEvent } from '../utils/database';
import { ProgressMetrics } from './types';

export class ProgressAggregator {
  private jobId: string;
  private metrics: ProgressMetrics;
  private updateIntervalMs: number;
  private persistIntervalMs: number;
  private lastUpdateTime: number = 0;
  private lastPersistTime: number = 0;
  private history: { timestamp: number; bytes: number }[] = [];
  
  private timer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private isFinished: boolean = false;

  constructor(jobId: string, initialMetrics: Partial<ProgressMetrics>, updateIntervalMs: number = 250, persistIntervalMs: number = 5000) {
    this.jobId = jobId;
    this.updateIntervalMs = updateIntervalMs;
    this.persistIntervalMs = persistIntervalMs;

    this.metrics = {
      totalFolders: 0,
      totalFiles: 0,
      totalBytes: 0,
      completedFolders: 0,
      completedFiles: 0,
      failedFiles: 0,
      transferredBytes: 0,
      currentFile: '',
      currentFolder: '',
      lastSuccessfulFile: '',
      currentWorkers: 0,
      idleWorkers: 0,
      busyWorkers: 0,
      queueLength: 0,
      currentSpeed: 0,
      averageSpeed: 0,
      eta: 0,
      status: 'running',
      networkStatus: 'online',
      ...initialMetrics
    };
  }

  public start() {
    this.history.push({ timestamp: Date.now(), bytes: this.metrics.transferredBytes });
    this.lastUpdateTime = Date.now();
    this.lastPersistTime = Date.now();
    
    // UI update loop
    this.timer = setInterval(() => {
      this.calculateSpeeds();
      this.emitUpdate();
    }, this.updateIntervalMs);

    // Persistence loop
    this.persistTimer = setInterval(() => {
      this.persist();
    }, this.persistIntervalMs);
  }

  public stop() {
    this.isFinished = true;
    if (this.timer) clearInterval(this.timer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.calculateSpeeds();
    this.emitUpdate();
    this.persist();
  }

  public reportProgress(updates: Partial<ProgressMetrics>) {
    Object.assign(this.metrics, updates);
  }

  public getMetrics(): ProgressMetrics {
    return this.metrics;
  }

  public reportFileCompleted(size: number, name: string) {
    this.metrics.completedFiles++;
    this.metrics.transferredBytes += size;
    this.metrics.lastSuccessfulFile = name;
  }

  public reportFolderCompleted(name: string) {
    this.metrics.completedFolders++;
    this.metrics.currentFolder = name;
  }

  public reportFileFailed() {
    this.metrics.failedFiles++;
  }

  private calculateSpeeds() {
    const now = Date.now();
    this.history.push({ timestamp: now, bytes: this.metrics.transferredBytes });
    
    // Keep last 10 seconds of history for current speed
    const cutoff = now - 10000;
    while (this.history.length > 0 && this.history[0].timestamp < cutoff) {
      this.history.shift();
    }

    if (this.history.length > 1) {
      const oldest = this.history[0];
      const timeDiff = (now - oldest.timestamp) / 1000; // in seconds
      const bytesDiff = this.metrics.transferredBytes - oldest.bytes;
      
      if (timeDiff > 0) {
        this.metrics.currentSpeed = bytesDiff / timeDiff;
      }
    } else {
      this.metrics.currentSpeed = 0;
    }

    // Average speed (from beginning, approximating by using lastPersistTime if we had total time, 
    // but typically average speed isn't strictly necessary or we can compute it using total time elapsed).
    // For now, ETA is based on current speed.
    if (this.metrics.currentSpeed > 0) {
      const remainingBytes = Math.max(0, this.metrics.totalBytes - this.metrics.transferredBytes);
      this.metrics.eta = remainingBytes / this.metrics.currentSpeed;
    } else {
      this.metrics.eta = 0;
    }
  }

  private emitUpdate() {
    if (this.isFinished) return;
    
    let percent = 0;
    if (this.metrics.totalBytes > 0) {
      percent = Math.floor((this.metrics.transferredBytes / this.metrics.totalBytes) * 100);
    }
    
    console.log(`[PROGRESS] Emit Progress\nJob: ${this.jobId}\nBytes: ${this.metrics.transferredBytes}/${this.metrics.totalBytes}\nFiles: ${this.metrics.completedFiles}/${this.metrics.totalFiles}\nFolders: ${this.metrics.completedFolders}/${this.metrics.totalFolders}\nPercent: ${percent}%\nWorkers: ${this.metrics.busyWorkers}`);
    
    updateJobProgress(this.jobId, this.metrics).catch(console.error);
  }

  private persist() {
    // We can also persist full state or heavy state here.
    // Currently, updateJobProgress does the persistence.
    // This allows decoupling fast UI updates (if using WS) from slower DB writes.
    // For now, emitUpdate does DB writes.
  }
}
