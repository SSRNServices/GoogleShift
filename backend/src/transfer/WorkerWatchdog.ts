// @ts-nocheck
import { prisma, logJobEvent, updateJobStatus } from '../utils/database';
import { jobRegistry } from './JobRegistry';

/**
 * WorkerWatchdog — active recovery watchdog for all running migration jobs.
 *
 * PREVIOUS BEHAVIOUR (broken):
 *   - Polled DB every 60s
 *   - Detected stalls
 *   - Logged JOB_STALLED
 *   - Did nothing else
 *
 * NEW BEHAVIOUR:
 *   1. Polls the global JobRegistry (in-process) every WATCHDOG_TICK_MS
 *   2. For each registered scheduler:
 *      a. If lastProgressAt hasn't advanced for INACTIVITY_STALL_MS → call abortStalledWorkers()
 *      b. If the scheduler has no running workers AND unresolved items in DB → trigger deadlock recovery
 *   3. Falls back to DB polling for jobs that may have lost their scheduler reference
 *      (e.g., after a hot-reload or if a scheduler failed to deregister)
 *   4. Emits DB log events for any stall so operators can see them in the audit log
 *   5. Never leaves a job permanently stuck — escalates to FAILED after MAX_RECOVERY_ATTEMPTS
 */

/** How often the watchdog runs its full check */
const WATCHDOG_TICK_MS = 60_000; // 60 seconds

/**
 * How long without byte progress before the watchdog intervenes.
 * This is deliberately higher than the per-worker stall threshold (5 min)
 * to give the scheduler's own stall detection a chance to fire first.
 * Watchdog is the last line of defence.
 */
const INACTIVITY_STALL_MS = 8 * 60 * 1000; // 8 minutes

/**
 * How many recovery attempts before the watchdog gives up and marks the job FAILED.
 * Each attempt = one WATCHDOG_TICK_MS cycle without progress.
 */
const MAX_RECOVERY_ATTEMPTS = 3;

interface JobSnapshot {
  completedFiles: number;
  transferredBytes: bigint;
  lastChangeAt: number;
  recoveryAttempts: number;
}

export class WorkerWatchdog {
  private intervalId: NodeJS.Timeout | null = null;
  private snapshots: Map<string, JobSnapshot> = new Map();

  public start(): void {
    if (this.intervalId) return;
    console.log(
      `[WorkerWatchdog] WATCHDOG_START | TickMs: ${WATCHDOG_TICK_MS} | ` +
      `InactivityThreshold: ${INACTIVITY_STALL_MS / 1000}s | ` +
      `MaxRecoveryAttempts: ${MAX_RECOVERY_ATTEMPTS}`
    );
    this.intervalId = setInterval(() => this.tick(), WATCHDOG_TICK_MS);
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log(`[WorkerWatchdog] WATCHDOG_STOP`);
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.checkRegisteredSchedulers();
      await this.checkOrphanedDBJobs();
    } catch (e: any) {
      console.error(`[WorkerWatchdog] Tick error: ${e.message}`);
    }
  }

  /**
   * Check schedulers registered in the JobRegistry (in-process).
   * These are jobs that are currently running in THIS process.
   */
  private async checkRegisteredSchedulers(): Promise<void> {
    await jobRegistry.recoverStalledJobs(INACTIVITY_STALL_MS);

    // Also do snapshot-based stall detection for the DB audit log
    for (const jobId of jobRegistry.getActiveJobIds()) {
      const handle = jobRegistry.get(jobId);
      if (!handle || !handle.isRunning) continue;

      const job = await prisma.migrationJob.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          state: true,
          completedFiles: true,
          transferredBytes: true,
          currentFile: true,
          manifestId: true
        }
      }).catch(() => null);

      if (!job) continue;

      const currentFiles = job.completedFiles || 0;
      const currentBytes = job.transferredBytes || BigInt(0);
      const now = Date.now();

      let snapshot = this.snapshots.get(jobId);
      if (!snapshot) {
        this.snapshots.set(jobId, {
          completedFiles: currentFiles,
          transferredBytes: currentBytes,
          lastChangeAt: now,
          recoveryAttempts: 0
        });
        continue;
      }

      const filesChanged = currentFiles !== snapshot.completedFiles;
      const bytesChanged = currentBytes !== snapshot.transferredBytes;

      if (filesChanged || bytesChanged) {
        snapshot.completedFiles = currentFiles;
        snapshot.transferredBytes = currentBytes;
        snapshot.lastChangeAt = now;
        snapshot.recoveryAttempts = 0;
        continue;
      }

      const stallDuration = now - snapshot.lastChangeAt;
      if (stallDuration < INACTIVITY_STALL_MS) continue;

      // Stall detected
      snapshot.recoveryAttempts++;

      const queueDiag = await this.getQueueDiagnostics(job.manifestId);
      const msg =
        `[WorkerWatchdog] JOB_STALLED | JobId: ${jobId} | State: ${job.state} | ` +
        `CompletedFiles: ${currentFiles} | TransferredBytes: ${currentBytes} | ` +
        `StallDuration: ${Math.round(stallDuration / 1000)}s | ` +
        `CurrentFile: ${job.currentFile || 'none'} | ` +
        `ManifestStatus: [${queueDiag}] | ` +
        `RecoveryAttempt: ${snapshot.recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS} | ` +
        `BusyWorkers: ${handle.busyWorkerCount}`;

      console.error(`\n${'='.repeat(80)}`);
      console.error(msg);
      console.error(`${'='.repeat(80)}\n`);
      await logJobEvent(jobId, msg, 'error');

      if (snapshot.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        // Give up — mark the job as failed
        console.error(
          `[WorkerWatchdog] JOB_UNRECOVERABLE | JobId: ${jobId} | ` +
          `RecoveryAttempts: ${snapshot.recoveryAttempts} | Marking FAILED.`
        );
        await logJobEvent(
          jobId,
          `[WorkerWatchdog] JOB_UNRECOVERABLE after ${snapshot.recoveryAttempts} recovery attempts`,
          'error'
        );
        await updateJobStatus(jobId, 'failed').catch(() => {});
        handle.cancel();
        handle.abortAll('watchdog: unrecoverable stall').catch(() => {});
        jobRegistry.deregister(jobId);
        this.snapshots.delete(jobId);
      }
    }
  }

  /**
   * Check DB for jobs that show as COPYING/PREPARING but have NO registered scheduler.
   * These are orphaned jobs — either the scheduler crashed without deregistering,
   * or they're left over from a previous process restart.
   */
  private async checkOrphanedDBJobs(): Promise<void> {
    const activeJobs = await prisma.migrationJob.findMany({
      where: { state: { in: ['COPYING', 'PREPARING'] } },
      select: {
        id: true,
        state: true,
        completedFiles: true,
        transferredBytes: true,
        currentFile: true,
        startedAt: true,
        manifestId: true
      }
    });

    const now = Date.now();

    for (const job of activeJobs) {
      // Skip jobs that have a live scheduler — already handled above
      if (jobRegistry.get(job.id)) continue;

      // This is an orphaned job — scheduler is gone
      const snapshot = this.snapshots.get(job.id);
      if (!snapshot) {
        this.snapshots.set(job.id, {
          completedFiles: job.completedFiles || 0,
          transferredBytes: job.transferredBytes || BigInt(0),
          lastChangeAt: now,
          recoveryAttempts: 0
        });
        continue;
      }

      const stallDuration = now - snapshot.lastChangeAt;
      const ORPHAN_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes for orphaned jobs

      if (stallDuration >= ORPHAN_THRESHOLD_MS) {
        snapshot.recoveryAttempts++;

        // Recover stuck UPLOADING items in manifest back to QUEUED
        if (job.manifestId) {
          const recovered = await prisma.migrationManifest.updateMany({
            where: {
              jobId: job.manifestId,
              isFolder: false,
              status: { in: ['UPLOADING', 'DOWNLOADING', 'VERIFYING'] }
            },
            data: { status: 'QUEUED' }
          }).catch(() => ({ count: 0 }));

          if (recovered.count > 0) {
            console.warn(
              `[WorkerWatchdog] ORPHAN_RECOVERY | JobId: ${job.id} | ` +
              `Recovered ${recovered.count} stuck items to QUEUED | ` +
              `StallDuration: ${Math.round(stallDuration / 1000)}s`
            );
            await logJobEvent(
              job.id,
              `[WorkerWatchdog] Orphan recovery: moved ${recovered.count} stuck items to QUEUED`,
              'warn'
            );
            snapshot.lastChangeAt = now; // Reset stall timer
          }
        }

        if (snapshot.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS * 2) {
          // Orphaned job with no scheduler — mark failed after extended timeout
          console.error(
            `[WorkerWatchdog] ORPHAN_JOB_FAILED | JobId: ${job.id} | ` +
            `No scheduler found and stalled for ${Math.round(stallDuration / 1000)}s. Marking FAILED.`
          );
          await updateJobStatus(job.id, 'failed').catch(() => {});
          this.snapshots.delete(job.id);
        }
      }
    }

    // Clean up snapshots for jobs no longer in active states
    const activeIds = new Set(activeJobs.map(j => j.id));
    for (const id of this.snapshots.keys()) {
      if (!activeIds.has(id) && !jobRegistry.get(id)) {
        this.snapshots.delete(id);
      }
    }
  }

  private async getQueueDiagnostics(manifestId: string | null): Promise<string> {
    if (!manifestId) return 'N/A';
    try {
      const counts = await prisma.migrationManifest.groupBy({
        by: ['status'],
        where: { jobId: manifestId },
        _count: { id: true }
      });
      return counts.map(c => `${c.status}:${c._count.id}`).join(' | ');
    } catch {
      return 'N/A';
    }
  }
}

export const workerWatchdog = new WorkerWatchdog();
