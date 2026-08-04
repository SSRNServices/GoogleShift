/**
 * migration-engine.test.ts
 *
 * Targeted unit tests for the architectural fixes in the migration engine redesign.
 * Tests cover:
 *   1. Adaptive timeout calculation
 *   2. Error classification
 *   3. RetryHelper behavior
 *   4. JobRegistry operations
 *   5. Error class properties and GoogleApiError factory
 *   6. RetryHelper static helpers
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import { classifyError, DownloadTimeoutError, UploadTimeoutError, UploadStallError, PermanentUploadError, JobCancelledError, GoogleApiError } from '../src/utils/errors';
import { RetryHelper } from '../src/utils/retry';
import { jobRegistry } from '../src/transfer/JobRegistry';

// ── Test utilities ─────────────────────────────────────────────────────────────

function makeAxiosError(status: number, code?: string, reason?: string): any {
  return {
    message: `HTTP ${status}`,
    response: {
      status,
      data: reason ? { error: { errors: [{ reason }] } } : {}
    },
    code
  };
}

function makeNodeError(code: string): any {
  return { message: code, code };
}

// ── 1. Adaptive timeout calculation ───────────────────────────────────────────

describe('Adaptive Transfer Timeout', () => {
  // Replicate the formula from UploadWorker
  const MIN_SPEED = 512 * 1024; // 512 KB/s
  const MIN_TIMEOUT = 10 * 60 * 1000; // 10 min
  const MAX_TIMEOUT = 8 * 60 * 60 * 1000; // 8 hours

  function computeTimeout(bytes: number): number {
    const sized = (bytes / MIN_SPEED) * 1000;
    return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, sized));
  }

  test('zero-byte file gets minimum timeout', () => {
    expect(computeTimeout(0)).toBe(MIN_TIMEOUT);
  });

  test('1 KB file gets minimum timeout', () => {
    expect(computeTimeout(1024)).toBe(MIN_TIMEOUT);
  });

  test('1 MB file gets minimum timeout (1MB / 512KB/s = 2s < 10min)', () => {
    expect(computeTimeout(1024 * 1024)).toBe(MIN_TIMEOUT);
  });

  test('2 GB audio file gets > 10 minutes', () => {
    const twoGB = 2 * 1024 * 1024 * 1024;
    const timeout = computeTimeout(twoGB);
    expect(timeout).toBeGreaterThan(10 * 60 * 1000);
    // 2GB / 512KB/s = 4096s ≈ 68 minutes
    expect(timeout).toBeGreaterThan(60 * 60 * 1000); // > 1 hour
  });

  test('100 GB file gets well over 1 hour but not more than max', () => {
    const hundredGB = 100 * 1024 * 1024 * 1024;
    const timeout = computeTimeout(hundredGB);
    expect(timeout).toBeGreaterThan(60 * 60 * 1000);
    expect(timeout).toBeLessThanOrEqual(MAX_TIMEOUT);
  });

  test('enormous file is capped at MAX_TIMEOUT', () => {
    const petabyte = 1024 * 1024 * 1024 * 1024 * 1024;
    expect(computeTimeout(petabyte)).toBe(MAX_TIMEOUT);
  });
});

// ── 2. Error classification ────────────────────────────────────────────────────

describe('classifyError', () => {
  describe('Permanent errors', () => {
    test('HTTP 401 is permanent', () => {
      expect(classifyError(makeAxiosError(401))).toBe('permanent');
    });

    test('HTTP 404 is permanent', () => {
      expect(classifyError(makeAxiosError(404))).toBe('permanent');
    });

    test('HTTP 403 without rate-limit reason is permanent', () => {
      expect(classifyError(makeAxiosError(403))).toBe('permanent');
    });

    test('HTTP 400 is permanent', () => {
      expect(classifyError(makeAxiosError(400))).toBe('permanent');
    });

    test('PermanentUploadError instance is permanent', () => {
      expect(classifyError(new PermanentUploadError('quota exceeded', 403))).toBe('permanent');
    });

    test('JobCancelledError is permanent (should not retry)', () => {
      expect(classifyError(new JobCancelledError('job-123'))).toBe('permanent');
    });
  });

  describe('Retryable errors', () => {
    test('HTTP 429 is retryable', () => {
      expect(classifyError(makeAxiosError(429))).toBe('retryable');
    });

    test('HTTP 500 is retryable', () => {
      expect(classifyError(makeAxiosError(500))).toBe('retryable');
    });

    test('HTTP 503 is retryable', () => {
      expect(classifyError(makeAxiosError(503))).toBe('retryable');
    });

    test('HTTP 403 with userRateLimitExceeded is retryable', () => {
      expect(classifyError(makeAxiosError(403, undefined, 'userRateLimitExceeded'))).toBe('retryable');
    });

    test('ECONNRESET is retryable', () => {
      expect(classifyError(makeNodeError('ECONNRESET'))).toBe('retryable');
    });

    test('ETIMEDOUT is retryable', () => {
      expect(classifyError(makeNodeError('ETIMEDOUT'))).toBe('retryable');
    });

    test('EPIPE is retryable', () => {
      expect(classifyError(makeNodeError('EPIPE'))).toBe('retryable');
    });

    test('AbortError is retryable (timed-out stream should retry)', () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      expect(classifyError(e)).toBe('retryable');
    });

    test('DownloadTimeoutError is retryable', () => {
      expect(classifyError(new DownloadTimeoutError('timed out', 300000))).toBe('retryable');
    });

    test('UploadTimeoutError is retryable', () => {
      expect(classifyError(new UploadTimeoutError('upload timeout', 600000, 1024))).toBe('retryable');
    });

    test('UploadStallError is retryable', () => {
      expect(classifyError(new UploadStallError('no bytes for 3 min', 180000))).toBe('retryable');
    });

    test('socket hang up is retryable', () => {
      expect(classifyError({ message: 'socket hang up' })).toBe('retryable');
    });
  });

  describe('Unknown errors', () => {
    test('generic error is unknown', () => {
      expect(classifyError(new Error('something weird happened'))).toBe('unknown');
    });
  });
});

// ── 3. RetryHelper behavior ────────────────────────────────────────────────────

describe('RetryHelper', () => {
  test('succeeds on first attempt', async () => {
    const result = await RetryHelper.withRetry('test', async () => 'ok');
    expect(result).toBe('ok');
  });

  test('retries transient errors and eventually succeeds', async () => {
    let attempts = 0;
    const result = await RetryHelper.withRetry(
      'flaky-op',
      async () => {
        attempts++;
        if (attempts < 3) throw makeAxiosError(503);
        return 'success';
      },
      { maxAttempts: 5, baseDelayMs: 1 }
    );
    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  test('does NOT retry permanent errors (401)', async () => {
    let attempts = 0;
    await expect(
      RetryHelper.withRetry(
        'auth-fail',
        async () => {
          attempts++;
          throw makeAxiosError(401);
        },
        { maxAttempts: 5, baseDelayMs: 1 }
      )
    ).rejects.toMatchObject({ response: { status: 401 } });
    expect(attempts).toBe(1); // Only tried once — permanent = no retry
  });

  test('throws after maxAttempts exhausted', async () => {
    let attempts = 0;
    await expect(
      RetryHelper.withRetry(
        'exhausted',
        async () => {
          attempts++;
          throw makeAxiosError(500);
        },
        { maxAttempts: 3, baseDelayMs: 1 }
      )
    ).rejects.toBeDefined();
    expect(attempts).toBe(3);
  });

  test('calls onRetry callback on each retry', async () => {
    const retryCalls: number[] = [];
    await expect(
      RetryHelper.withRetry(
        'retry-cb',
        async () => { throw makeAxiosError(503); },
        {
          maxAttempts: 3,
          baseDelayMs: 1,
          onRetry: (attempt) => { retryCalls.push(attempt); }
        }
      )
    ).rejects.toBeDefined();
    // 3 attempts = 2 retries (attempt 1 throws, onRetry called for attempt 1 and 2)
    expect(retryCalls.length).toBe(2);
  });

  test('backwards-compatible with (name, fn, logFn) signature', async () => {
    const logs: string[] = [];
    const result = await RetryHelper.withRetry(
      'compat',
      async () => 'ok',
      (msg) => logs.push(msg)
    );
    expect(result).toBe('ok');
  });
});

// ── 4. JobRegistry ─────────────────────────────────────────────────────────────

describe('JobRegistry', () => {
  afterEach(() => {
    // Clean up any registered handles
    for (const id of jobRegistry.getActiveJobIds()) {
      jobRegistry.deregister(id);
    }
  });

  function makeHandle(jobId: string, lastProgressAt = Date.now()): any {
    return {
      jobId,
      isRunning: true,
      lastProgressAt,
      busyWorkerCount: 1,
      cancel: vi.fn(),
      abortAll: vi.fn().mockResolvedValue(undefined),
      abortStalledWorkers: vi.fn().mockResolvedValue(undefined)
    };
  }

  test('register and get', () => {
    const handle = makeHandle('job-1');
    jobRegistry.register('job-1', handle);
    expect(jobRegistry.get('job-1')).toBe(handle);
  });

  test('deregister removes handle', () => {
    const handle = makeHandle('job-2');
    jobRegistry.register('job-2', handle);
    jobRegistry.deregister('job-2');
    expect(jobRegistry.get('job-2')).toBeUndefined();
  });

  test('getActiveJobIds returns all registered IDs', () => {
    jobRegistry.register('job-3', makeHandle('job-3'));
    jobRegistry.register('job-4', makeHandle('job-4'));
    const ids = jobRegistry.getActiveJobIds();
    expect(ids).toContain('job-3');
    expect(ids).toContain('job-4');
  });

  test('cancelJob calls cancel() and abortAll() on the handle', async () => {
    const handle = makeHandle('job-5');
    jobRegistry.register('job-5', handle);
    await jobRegistry.cancelJob('job-5');
    expect(handle.cancel).toHaveBeenCalled();
    expect(handle.abortAll).toHaveBeenCalledWith('Job cancelled by user');
    // Should be deregistered after cancel
    expect(jobRegistry.get('job-5')).toBeUndefined();
  });

  test('cancelJob on non-existent job does not throw', async () => {
    await expect(jobRegistry.cancelJob('non-existent')).resolves.not.toThrow();
  });

  test('recoverStalledJobs calls abortStalledWorkers for stalled schedulers', async () => {
    const OLD_TIME = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const handle = makeHandle('job-6', OLD_TIME);
    jobRegistry.register('job-6', handle);

    await jobRegistry.recoverStalledJobs(5 * 60 * 1000); // 5 min threshold

    expect(handle.abortStalledWorkers).toHaveBeenCalledWith(5 * 60 * 1000);
  });

  test('recoverStalledJobs does NOT call abortStalledWorkers for healthy schedulers', async () => {
    const RECENT = Date.now() - 30_000; // 30 seconds ago
    const handle = makeHandle('job-7', RECENT);
    jobRegistry.register('job-7', handle);

    await jobRegistry.recoverStalledJobs(5 * 60 * 1000); // 5 min threshold

    expect(handle.abortStalledWorkers).not.toHaveBeenCalled();
  });
});

// ── 5. Error class properties ─────────────────────────────────────────────────

describe('Error class properties', () => {
  test('DownloadTimeoutError carries elapsed time', () => {
    const e = new DownloadTimeoutError('timeout', 300_000);
    expect(e.name).toBe('DownloadTimeoutError');
    expect(e.elapsed).toBe(300_000);
    expect(e.isRetryable).toBe(true);
    expect(e.isPermanent).toBe(false);
    expect(e instanceof Error).toBe(true);
  });

  test('UploadTimeoutError carries elapsed and bytesTransferred', () => {
    const e = new UploadTimeoutError('timeout', 600_000, 1024 * 1024);
    expect(e.name).toBe('UploadTimeoutError');
    expect(e.elapsed).toBe(600_000);
    expect(e.bytesTransferred).toBe(1024 * 1024);
    expect(e.isRetryable).toBe(true);
  });

  test('PermanentUploadError is not retryable', () => {
    const e = new PermanentUploadError('permission denied', 403);
    expect(e.isPermanent).toBe(true);
    expect(e.isRetryable).toBe(false);
    expect(e.httpStatus).toBe(403);
  });

  test('JobCancelledError carries jobId', () => {
    const e = new JobCancelledError('job-abc');
    expect(e.jobId).toBe('job-abc');
    expect(e.isPermanent).toBe(true);
    expect(e.isRetryable).toBe(false);
  });

  test('GoogleApiError.fromAxiosError creates correct error for 429', () => {
    const axiosErr = makeAxiosError(429);
    const e = GoogleApiError.fromAxiosError(axiosErr);
    expect(e.isRetryable).toBe(true);
    expect(e.isPermanent).toBe(false);
    expect(e.httpStatus).toBe(429);
  });

  test('GoogleApiError.fromAxiosError creates correct error for 404', () => {
    const axiosErr = makeAxiosError(404);
    const e = GoogleApiError.fromAxiosError(axiosErr);
    expect(e.isPermanent).toBe(true);
    expect(e.isRetryable).toBe(false);
  });
});

// ── 6. RetryHelper.isRetryable / isPermanent helpers ──────────────────────────

describe('RetryHelper static helpers', () => {
  test('isRetryable(429 error) is true', () => {
    expect(RetryHelper.isRetryable(makeAxiosError(429))).toBe(true);
  });

  test('isPermanent(404 error) is true', () => {
    expect(RetryHelper.isPermanent(makeAxiosError(404))).toBe(true);
  });

  test('isRetryable(ECONNRESET) is true', () => {
    expect(RetryHelper.isRetryable(makeNodeError('ECONNRESET'))).toBe(true);
  });

  test('isPermanent(generic Error) is false', () => {
    expect(RetryHelper.isPermanent(new Error('unknown'))).toBe(false);
  });
});
