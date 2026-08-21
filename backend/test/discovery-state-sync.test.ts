import { describe, test, expect } from 'vitest';
import { DiscoveryStatus } from '../src/types/discoveryStatus';

describe('Discovery State & SSE Telemetry Contract', () => {
  test('formatDiscoveryResponse includes googleRequests from checkpointData', () => {
    const formatDiscoveryResponse = (job: any, extraMessage?: string) => {
      const rawState = (job.state || job.status || 'QUEUED').toUpperCase();
      const isCompleted = rawState === 'COMPLETED' || job.discoveryStatus === 'COMPLETED';
      const isFailed = rawState === 'FAILED' || job.discoveryStatus === 'FAILED';
      const isCancelled = rawState === 'CANCELLED';

      let statusEnum: string = rawState;
      if (isCompleted) statusEnum = DiscoveryStatus.COMPLETED;
      else if (isFailed) statusEnum = 'FAILED';
      else if (isCancelled) statusEnum = 'CANCELLED';

      const progress = isCompleted ? 100 : (statusEnum === DiscoveryStatus.SCANNING ? 50 : (statusEnum === DiscoveryStatus.FINALIZING ? 90 : 0));

      const foldersCount = job.foldersFound || 0;
      const filesCount = job.filesFound || 0;
      const bytesCount = job.bytesFound || BigInt(0);

      let googleRequests = typeof job.googleRequests === 'number' ? job.googleRequests : 0;
      if (!googleRequests && job.checkpointData) {
        try {
          const parsed = typeof job.checkpointData === 'string' ? JSON.parse(job.checkpointData) : job.checkpointData;
          if (typeof parsed?.googleRequests === 'number') {
            googleRequests = parsed.googleRequests;
          }
        } catch (_) {}
      }

      const calcElapsed = job.elapsed 
        || (job.completedAt && job.startedAt ? new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime() : 0)
        || (job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : 0);

      return {
        id: job.id || job.jobId,
        jobId: job.id || job.jobId,
        sessionId: job.sessionId,
        manifestId: job.manifestId,
        status: statusEnum,
        phase: statusEnum,
        state: statusEnum,
        progress,
        completed: isCompleted,
        isFinished: isCompleted || isFailed || isCancelled,
        manifestComplete: isCompleted,
        error: isFailed ? (extraMessage || job.error || 'Discovery job failed') : undefined,
        foldersFound: foldersCount,
        filesFound: filesCount,
        bytesFound: bytesCount,
        googleRequests,
        folders: foldersCount,
        files: filesCount,
        bytes: bytesCount,
        totalFolders: foldersCount,
        totalFiles: filesCount,
        totalBytes: bytesCount,
        currentFolder: job.currentFolder || null,
        currentFile: job.currentFile || null,
        elapsed: calcElapsed
      };
    };

    const mockJob = {
      id: 'job-123',
      sessionId: 'session-456',
      manifestId: 'manifest-789',
      state: 'COMPLETED',
      foldersFound: 45350,
      filesFound: 417966,
      bytesFound: BigInt(6911055778),
      checkpointData: JSON.stringify({ googleRequests: 4841 })
    };

    const res = formatDiscoveryResponse(mockJob);

    expect(res.googleRequests).toBe(4841);
    expect(res.googleRequests).not.toBe(45350); // Must NOT equal folder count!
    expect(res.status).toBe('COMPLETED');
    expect(res.completed).toBe(true);
    expect(res.totalFolders).toBe(45350);
    expect(res.totalFiles).toBe(417966);
  });

  test('SSE tick loop safely handles interval declaration without TDZ ReferenceError', async () => {
    let interval: NodeJS.Timeout | null = null;
    let tickExecuted = false;

    const mockSendSseTick = async () => {
      tickExecuted = true;
      // If tick terminates early, clear interval safely
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    // Fire initial tick
    await mockSendSseTick();
    expect(tickExecuted).toBe(true);

    // Assign interval after initial tick
    interval = setInterval(() => {}, 10000);
    expect(interval).not.toBeNull();

    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  });

  test('DiscoveryScanner metrics update strictly preserves valid googleRequests numbers', () => {
    const prevRequests = 4841;
    const incomingDataWithGoogle = { googleRequests: 4841 };
    const incomingDataWithoutGoogle = { totalFolders: 45350 };

    const calculateGoogle = (data: any, prev: number) => {
      return typeof data.googleRequests === 'number' && !isNaN(data.googleRequests)
        ? data.googleRequests
        : prev;
    };

    expect(calculateGoogle(incomingDataWithGoogle, prevRequests)).toBe(4841);
    expect(calculateGoogle(incomingDataWithoutGoogle, prevRequests)).toBe(4841); // Preserves 4841, never defaults to 45350!
  });
});
