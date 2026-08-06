import { classifyError, MigrationError } from './errors';

/**
 * Options for RetryHelper.withRetry
 */
export interface RetryOptions {
  /** Maximum number of attempts (default: 5) */
  maxAttempts?: number;
  /** Base backoff delay in milliseconds for exponential backoff (default: 1000ms) */
  baseDelayMs?: number;
  /** Maximum backoff delay cap in milliseconds (default: 30000ms) */
  maxDelayMs?: number;
  /** Jitter factor 0–1 applied to backoff (default: 0.3 = ±30%) */
  jitter?: number;
  /** If provided, called on each retry attempt */
  onRetry?: (attempt: number, error: any, delayMs: number) => void;
  /** If provided, called when a 429 rate-limit is encountered */
  onRateLimit?: () => void;
  /** Log function (default: console.log) */
  logFn?: (msg: string) => void;
}

/**
 * RetryHelper — wraps any async operation with exponential backoff and jitter.
 *
 * Key behaviours:
 * - Permanent errors (401, 403, 404, 400) are NOT retried — thrown immediately
 * - Retryable errors (429, 5xx, ECONNRESET, ETIMEDOUT, AbortError) are retried
 * - Unknown errors that are not classified as permanent are retried by default
 *   (conservative: prefer retry over permanent failure for unknown states)
 * - Every retry logs at the operation level with attempt count and delay
 */
export class RetryHelper {
  public static async withRetry<T>(
    operationName: string,
    operation: () => Promise<T>,
    logFnOrOptions?: ((msg: string) => void) | RetryOptions,
    onRateLimit?: () => void
  ): Promise<T> {
    // Backwards-compatible overload: accept (name, fn, logFn, onRateLimit)
    let opts: RetryOptions = {};
    if (typeof logFnOrOptions === 'function') {
      opts = { logFn: logFnOrOptions, onRateLimit };
    } else if (logFnOrOptions && typeof logFnOrOptions === 'object') {
      opts = logFnOrOptions;
    }

    const {
      maxAttempts = 3,
      baseDelayMs = 300,
      maxDelayMs = 10_000,
      jitter = 0.3,
      onRetry,
      onRateLimit: onRateLimitOpt,
      logFn = (msg: string) => console.log(msg),
    } = opts;

    const effectiveOnRateLimit = onRateLimit ?? onRateLimitOpt;

    const startMs = Date.now();
    let lastError: any;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await operation();
        if (attempt > 0) {
          logFn(
            `[RetryHelper] SUCCESS after ${attempt + 1} attempt(s) | ` +
            `Operation: ${operationName} | Elapsed: ${Date.now() - startMs}ms`
          );
        }
        return result;
      } catch (e: any) {
        lastError = e;

        const classification = classifyError(e);
        const httpStatus = e?.response?.status ?? e?.status;
        const errorCode = e?.code ?? '';

        // Permanent errors — throw immediately, do not retry
        if (classification === 'permanent' || (e instanceof MigrationError && e.isPermanent)) {
          logFn(
            `[RetryHelper] PERMANENT_ERROR | Operation: ${operationName} | ` +
            `Status: ${httpStatus || errorCode || 'N/A'} | Error: ${e.message} | ` +
            `Attempt: ${attempt + 1}/${maxAttempts} | Elapsed: ${Date.now() - startMs}ms`
          );
          throw e;
        }

        // Last attempt — throw regardless
        if (attempt === maxAttempts - 1) {
          logFn(
            `[RetryHelper] MAX_RETRIES_EXCEEDED | Operation: ${operationName} | ` +
            `Attempts: ${maxAttempts} | Status: ${httpStatus || errorCode || 'N/A'} | ` +
            `Error: ${e.message} | Elapsed: ${Date.now() - startMs}ms`
          );
          throw e;
        }

        // Calculate exponential backoff with jitter
        const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
        const jitterMs = expDelay * jitter * (Math.random() * 2 - 1); // ±jitter%
        const delayMs = Math.max(100, Math.floor(expDelay + jitterMs));

        // Report rate limit if applicable
        if (httpStatus === 429 || httpStatus === 403) {
          effectiveOnRateLimit?.();
        }

        logFn(
          `[RetryHelper] RETRY | Operation: ${operationName} | ` +
          `Attempt: ${attempt + 1}/${maxAttempts} | ` +
          `Status: ${httpStatus || errorCode || 'N/A'} | ` +
          `Error: ${e.message} | ` +
          `DelayMs: ${delayMs} | Classification: ${classification}`
        );

        onRetry?.(attempt + 1, e, delayMs);

        await new Promise(res => setTimeout(res, delayMs));
      }
    }

    // Unreachable — TypeScript satisfaction
    throw lastError ?? new Error(`RetryHelper: exhausted ${maxAttempts} attempts for ${operationName}`);
  }

  /**
   * Classify error for external callers who need to make their own retry decisions
   */
  public static classifyError(e: any): 'retryable' | 'permanent' | 'unknown' {
    return classifyError(e);
  }

  /**
   * Quick helper: is this error retryable?
   */
  public static isRetryable(e: any): boolean {
    return classifyError(e) === 'retryable';
  }

  /**
   * Quick helper: is this error permanent (should never retry)?
   */
  public static isPermanent(e: any): boolean {
    return classifyError(e) === 'permanent';
  }
}
