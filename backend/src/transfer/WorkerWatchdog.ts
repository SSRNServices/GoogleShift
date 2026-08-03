// @ts-nocheck
import { prisma, logJobEvent, updateJobStatus } from '../utils/database';

/** How often the watchdog polls active jobs */
const WATCHDOG_INTERVAL_MS = 60 * 1000; // 60 seconds

/** If filesCopied AND bytesCopied are both unchanged for this long → stall */
const JOB_STALL_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

interface JobSnapshot {
  completedFiles: number;
  transferredBytes: bigint;
  lastChangeAt: number;
}

/**
 * WorkerWatchdog — monitors all COPYING jobs at the process level.
 *
 * Every 60 seconds it reads the DB state of every job in COPYING state.
 * If both completedFiles and transferredBytes have not changed for 10 minutes,
 * it logs a JOB_STALLED alert. This does NOT restart the job — it provides
 * actionable diagnostic information in the logs.
 */
export class WorkerWatchdog {
  private intervalId: NodeJS.Timeout | null = null;
  private snapshots: Map<string, JobSnapshot> = new Map();

  public start() {
    if (this.intervalId) return;
    console.log(`[WorkerWatchdog] WATCHDOG_START | Interval: ${WATCHDOG_INTERVAL_MS}ms`);
    this.intervalId = setInterval(() => this.tick(), WATCHDOG_INTERVAL_MS);
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log(`[WorkerWatchdog] WATCHDOG_STOP`);
    }
  }

  private async tick() {
    try {
      const activeJobs = await prisma.migrationJob.findMany({
        where: { state: { in: ['COPYING', 'PREPARING'] } },
        select: {
          id: true,
          state: true,
          completedFiles: true,
          failedFiles: true,
          transferredBytes: true,
          currentFile: true,
          currentFolder: true,
          startedAt: true
        }
      });

      if (activeJobs.length === 0) {
        // No active jobs — clean up stale snapshots
        this.snapshots.clear();
        return;
      }

      const now = Date.now();

      for (const job of activeJobs) {
        const currentFiles = job.completedFiles || 0;
        const currentBytes = job.transferredBytes || BigInt(0);

        const snapshot = this.snapshots.get(job.id);

        if (!snapshot) {
          // First time we've seen this job
          this.snapshots.set(job.id, {
            completedFiles: currentFiles,
            transferredBytes: currentBytes,
            lastChangeAt: now
          });
          continue;
        }

        const filesChanged = currentFiles !== snapshot.completedFiles;
        const bytesChanged = currentBytes !== snapshot.transferredBytes;

        if (filesChanged || bytesChanged) {
          // Job is making progress
          snapshot.completedFiles = currentFiles;
          snapshot.transferredBytes = currentBytes;
          snapshot.lastChangeAt = now;
          continue;
        }

        // No progress since last snapshot
        const stallDuration = now - snapshot.lastChangeAt;

        console.log(
          `[WorkerWatchdog] WATCHDOG_CHECK | JobId: ${job.id} | State: ${job.state} | ` +
          `CompletedFiles: ${currentFiles} | TransferredBytes: ${currentBytes} | ` +
          `StallDuration: ${Math.round(stallDuration / 1000)}s | ` +
          `CurrentFile: ${job.currentFile || 'none'} | ` +
          `CurrentFolder: ${job.currentFolder || 'none'}`
        );

        if (stallDuration >= JOB_STALL_THRESHOLD_MS) {
          // Get queue diagnostics
          const manifestRows = await prisma.migrationJob.findUnique({
            where: { id: job.id },
            select: { manifestId: true }
          });

          let queueDiag = 'N/A';
          if (manifestRows?.manifestId) {
            try {
              const counts = await prisma.migrationManifest.groupBy({
                by: ['status'],
                where: { jobId: manifestRows.manifestId },
                _count: { id: true }
              });
              const parts = counts.map(c => `${c.status}:${c._count.id}`);
              queueDiag = parts.join(' | ');
            } catch (_) {}
          }

          const msg =
            `[WorkerWatchdog] JOB_STALLED | JobId: ${job.id} | State: ${job.state} | ` +
            `CompletedFiles: ${currentFiles} | TransferredBytes: ${currentBytes} | ` +
            `StallDuration: ${Math.round(stallDuration / 1000)}s | ` +
            `CurrentFile: ${job.currentFile || 'none'} | ` +
            `CurrentFolder: ${job.currentFolder || 'none'} | ` +
            `ManifestStatus: [${queueDiag}]`;

          console.error(`\n${'='.repeat(70)}`);
          console.error(msg);
          console.error(`${'='.repeat(70)}\n`);

          await logJobEvent(job.id, msg, 'error');
        }
      }

      // Clean up snapshots for jobs no longer active
      const activeIds = new Set(activeJobs.map(j => j.id));
      for (const id of this.snapshots.keys()) {
        if (!activeIds.has(id)) this.snapshots.delete(id);
      }
    } catch (e: any) {
      console.error(`[WorkerWatchdog] Tick error: ${e.message}`);
    }
  }
}

export const workerWatchdog = new WorkerWatchdog();
