/**
 * JobRegistry — process-level singleton that maps jobId → active FileScheduler.
 *
 * This allows:
 *   1. WorkerWatchdog to reach active schedulers without polling
 *   2. The cancel endpoint to abort all workers for a job
 *   3. Any module to query whether a job is currently running
 *
 * Design constraints:
 *   - Thread-safe for single-process Node.js (no concurrent mutation issues)
 *   - Zero external dependencies (plain Map)
 *   - Supports multiple concurrent jobs (each user has one job; admin may have more)
 */

export interface ISchedulerHandle {
  jobId: string;
  /** Abort all active workers, reset their manifest items to QUEUED, stop the scheduler loop */
  abortAll(reason?: string): Promise<void>;
  /** Abort only workers that have been stalled for longer than stallThresholdMs */
  abortStalledWorkers(stallThresholdMs: number): Promise<void>;
  /** Signal the scheduler to stop after current workers finish (graceful shutdown) */
  cancel(): void;
  /** Whether the scheduler is still actively processing */
  isRunning: boolean;
  /** Timestamp of last byte of progress across any worker */
  lastProgressAt: number;
  /** How many workers are currently busy */
  busyWorkerCount: number;
}

class JobRegistry {
  private readonly schedulers = new Map<string, ISchedulerHandle>();

  /** Register a scheduler when a job starts */
  public register(jobId: string, handle: ISchedulerHandle): void {
    this.schedulers.set(jobId, handle);
    console.log(`[JobRegistry] REGISTERED | JobId: ${jobId} | TotalJobs: ${this.schedulers.size}`);
  }

  /** Deregister a scheduler when a job finishes or fails */
  public deregister(jobId: string): void {
    if (this.schedulers.has(jobId)) {
      this.schedulers.delete(jobId);
      console.log(`[JobRegistry] DEREGISTERED | JobId: ${jobId} | TotalJobs: ${this.schedulers.size}`);
    }
  }

  /** Get the active scheduler handle for a job (returns undefined if not running) */
  public get(jobId: string): ISchedulerHandle | undefined {
    return this.schedulers.get(jobId);
  }

  /** Get all currently running job IDs */
  public getActiveJobIds(): string[] {
    return Array.from(this.schedulers.keys());
  }

  /**
   * Cancel a specific job:
   * 1. Signals the scheduler to stop
   * 2. Aborts all active workers
   * 3. Deregisters the job
   */
  public async cancelJob(jobId: string): Promise<void> {
    const handle = this.schedulers.get(jobId);
    if (!handle) {
      console.warn(`[JobRegistry] CANCEL_MISS | JobId: ${jobId} — no active scheduler found`);
      return;
    }
    console.log(`[JobRegistry] CANCEL_JOB | JobId: ${jobId}`);
    handle.cancel();
    await handle.abortAll('Job cancelled by user');
    this.deregister(jobId);
  }

  /**
   * Used by WorkerWatchdog: find all running schedulers with no byte progress
   * for longer than stallThresholdMs, and attempt recovery.
   */
  public async recoverStalledJobs(stallThresholdMs: number): Promise<void> {
    const now = Date.now();
    for (const [jobId, handle] of this.schedulers) {
      if (!handle.isRunning) continue;
      const stalledMs = now - handle.lastProgressAt;
      if (stalledMs >= stallThresholdMs) {
        console.warn(
          `[JobRegistry] STALL_RECOVERY | JobId: ${jobId} | ` +
          `StallDuration: ${Math.round(stalledMs / 1000)}s | BusyWorkers: ${handle.busyWorkerCount}`
        );
        await handle.abortStalledWorkers(stallThresholdMs);
      }
    }
  }
}

/** Process-level singleton — import this everywhere, never instantiate JobRegistry directly */
export const jobRegistry = new JobRegistry();
