/**
 * Production error hierarchy for GoogleShift migration engine.
 * All custom errors extend MigrationError which carries retryable/permanent classification.
 */

// ── Base ───────────────────────────────────────────────────────────────────────

export class MigrationError extends Error {
  public readonly isRetryable: boolean;
  public readonly isPermanent: boolean;
  public readonly httpStatus?: number;

  constructor(message: string, opts: { isRetryable?: boolean; isPermanent?: boolean; httpStatus?: number } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.isRetryable = opts.isRetryable ?? false;
    this.isPermanent = opts.isPermanent ?? false;
    this.httpStatus = opts.httpStatus;
    // Maintains proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Download errors ────────────────────────────────────────────────────────────

export class DownloadError extends MigrationError {
  constructor(message: string, opts?: { isRetryable?: boolean; isPermanent?: boolean; httpStatus?: number }) {
    super(message, { isRetryable: true, ...opts });
    this.name = 'DownloadError';
  }
}

export class DownloadTimeoutError extends DownloadError {
  public readonly elapsed: number;
  constructor(message: string, elapsed: number) {
    super(message, { isRetryable: true });
    this.name = 'DownloadTimeoutError';
    this.elapsed = elapsed;
  }
}

export class DownloadStallError extends DownloadError {
  public readonly bytesSent: number;
  constructor(message: string, bytesSent: number) {
    super(message, { isRetryable: true });
    this.name = 'DownloadStallError';
    this.bytesSent = bytesSent;
  }
}

// ── Upload errors ──────────────────────────────────────────────────────────────

export class UploadError extends MigrationError {
  constructor(message: string, opts?: { isRetryable?: boolean; isPermanent?: boolean; httpStatus?: number }) {
    super(message, { isRetryable: true, ...opts });
    this.name = 'UploadError';
  }
}

export class UploadTimeoutError extends UploadError {
  public readonly elapsed: number;
  public readonly bytesTransferred: number;
  constructor(message: string, elapsed: number, bytesTransferred: number) {
    super(message, { isRetryable: true });
    this.name = 'UploadTimeoutError';
    this.elapsed = elapsed;
    this.bytesTransferred = bytesTransferred;
  }
}

export class UploadStallError extends UploadError {
  public readonly stallDuration: number;
  constructor(message: string, stallDuration: number) {
    super(message, { isRetryable: true });
    this.name = 'UploadStallError';
    this.stallDuration = stallDuration;
  }
}

export class RetryableUploadError extends UploadError {
  constructor(message: string, httpStatus?: number) {
    super(message, { isRetryable: true, httpStatus });
    this.name = 'RetryableUploadError';
  }
}

export class PermanentUploadError extends UploadError {
  constructor(message: string, httpStatus?: number) {
    super(message, { isPermanent: true, isRetryable: false, httpStatus });
    this.name = 'PermanentUploadError';
  }
}

// ── Google API errors ──────────────────────────────────────────────────────────

export class GoogleApiError extends MigrationError {
  public readonly requestId?: string;
  public readonly reason?: string;

  constructor(
    message: string,
    opts: {
      isRetryable?: boolean;
      isPermanent?: boolean;
      httpStatus?: number;
      requestId?: string;
      reason?: string;
    } = {}
  ) {
    super(message, opts);
    this.name = 'GoogleApiError';
    this.requestId = opts.requestId;
    this.reason = opts.reason;
  }

  public static fromAxiosError(e: any): GoogleApiError {
    const status = e?.response?.status;
    const reason = e?.response?.data?.error?.errors?.[0]?.reason || '';
    const requestId = e?.response?.headers?.['x-goog-request-id'];
    const message = e?.response?.data?.error?.message || e.message;

    const permanentStatuses = new Set([400, 401, 403, 404]);
    const retryableReasons = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError']);

    const isPermanent = permanentStatuses.has(status) && !retryableReasons.has(reason);
    const isRetryable = !isPermanent && (status === 429 || status >= 500 || retryableReasons.has(reason));

    return new GoogleApiError(message, { isRetryable, isPermanent, httpStatus: status, requestId, reason });
  }
}

// ── Manifest / state errors ────────────────────────────────────────────────────

export class ManifestCorruptionError extends MigrationError {
  constructor(message: string) {
    super(message, { isPermanent: true });
    this.name = 'ManifestCorruptionError';
  }
}

// ── Worker / scheduler errors ──────────────────────────────────────────────────

export class WorkerDeadlockError extends MigrationError {
  public readonly workerId: number;
  constructor(message: string, workerId: number) {
    super(message, { isRetryable: true });
    this.name = 'WorkerDeadlockError';
    this.workerId = workerId;
  }
}

export class JobStalledError extends MigrationError {
  public readonly jobId: string;
  public readonly stallSeconds: number;
  constructor(message: string, jobId: string, stallSeconds: number) {
    super(message, { isRetryable: true });
    this.name = 'JobStalledError';
    this.jobId = jobId;
    this.stallSeconds = stallSeconds;
  }
}

export class StreamDeadlockError extends MigrationError {
  constructor(message: string) {
    super(message, { isRetryable: true });
    this.name = 'StreamDeadlockError';
  }
}

export class StreamLifecycleError extends MigrationError {
  constructor(message: string) {
    super(message, { isPermanent: true, isRetryable: false });
    this.name = 'StreamLifecycleError';
  }
}

export class JobCancelledError extends MigrationError {
  public readonly jobId: string;
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled`, { isRetryable: false, isPermanent: true });
    this.name = 'JobCancelledError';
    this.jobId = jobId;
  }
}

// ── Validation / request errors ────────────────────────────────────────────────

export class RequestValidationError extends MigrationError {
  constructor(message: string) {
    super(message, { isPermanent: true });
    this.name = 'RequestValidationError';
  }
}

export class ManifestError extends MigrationError {
  constructor(message: string) {
    super(message, { isPermanent: true });
    this.name = 'ManifestError';
  }
}

export class ShortcutResolutionError extends MigrationError {
  constructor(message: string) {
    super(message, { isRetryable: true });
    this.name = 'ShortcutResolutionError';
  }
}

export class GoogleDriveError extends MigrationError {
  constructor(message: string) {
    super(message, { isRetryable: true });
    this.name = 'GoogleDriveError';
  }
}

// ── Utility ────────────────────────────────────────────────────────────────────

/**
 * Classify any caught error for retry decision-making.
 * Returns 'retryable' | 'permanent' | 'unknown'.
 */
export function classifyError(e: any): 'retryable' | 'permanent' | 'unknown' {
  // Already classified
  if (e instanceof MigrationError) {
    if (e.isPermanent) return 'permanent';
    if (e.isRetryable) return 'retryable';
    return 'unknown';
  }

  const msg = e?.message ?? '';
  const code = e?.code ?? e?.cause?.code;

  if (
    msg.includes('push() after EOF') ||
    msg.includes('ERR_STREAM_PUSH_AFTER_EOF') ||
    code === 'ERR_STREAM_PUSH_AFTER_EOF' ||
    e?.name === 'StreamLifecycleError'
  ) {
    return 'permanent';
  }

  const status = e?.response?.status ?? e?.status;
  const reason = e?.response?.data?.error?.errors?.[0]?.reason ?? '';

  // Permanent HTTP status codes
  if (status === 401 || status === 404) return 'permanent';
  if (status === 403 && reason !== 'rateLimitExceeded' && reason !== 'userRateLimitExceeded' && reason !== 'backendError') return 'permanent';
  if (status === 400) return 'permanent';

  // Retryable HTTP status codes (including 403 rate-limits)
  if (status === 429) return 'retryable';
  if (status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'backendError')) return 'retryable';
  if (status !== undefined && status >= 500) return 'retryable';

  // Retryable Node network codes
  const retryCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'];
  if (code && retryCodes.includes(code)) return 'retryable';

  // Abort / timeout signals
  if (e?.name === 'AbortError' || e?.type === 'aborted') return 'retryable';
  if (msg.includes('socket hang up')) return 'retryable';
  if (msg.includes('ECONNRESET')) return 'retryable';
  if (msg.includes('ETIMEDOUT')) return 'retryable';
  if (msg.includes('EAI_AGAIN')) return 'retryable';

  return 'unknown';
}
