import { formatDetailedError } from './errors';

export type ErrorClassification =
  | 'DESTINATION_FOLDER_CHILD_LIMIT'
  | 'RATE_LIMIT'
  | 'STORAGE_LIMIT'
  | 'PERMISSION_DENIED'
  | 'INVALID_PARENT'
  | 'STREAM_INTERRUPTED'
  | 'NETWORK_ERROR'
  | 'AUTHENTICATION_FAILURE'
  | 'UNKNOWN';

export interface NormalizedGoogleError {
  classification: ErrorClassification;
  retryable: boolean;
  httpStatus?: number;
  googleReason?: string;
  googleMessage?: string;
  operation: string;
  sourceFileId?: string;
  sourceFolderId?: string;
  destinationFolderId?: string;
  message: string;
  originalError?: any;
}

export class GoogleDriveErrorClassifier {
  /**
   * Classify any error returned from Google Drive API operations
   */
  public static classify(
    e: any,
    context?: {
      operation?: string;
      sourceFileId?: string;
      sourceFolderId?: string;
      destinationFolderId?: string;
    }
  ): NormalizedGoogleError {
    const operation = context?.operation || 'files.create';
    const sourceFileId = context?.sourceFileId;
    const sourceFolderId = context?.sourceFolderId;
    const destinationFolderId = context?.destinationFolderId;

    if (!e) {
      return {
        classification: 'UNKNOWN',
        retryable: false,
        operation,
        sourceFileId,
        sourceFolderId,
        destinationFolderId,
        message: 'Unknown error'
      };
    }

    // Extract HTTP status code
    const httpStatus = e?.response?.status ?? e?.status ?? e?.httpStatus;

    // Extract Google API reason and message
    const errorData = e?.response?.data?.error;
    const errorsList = errorData?.errors || e?.errors;
    let googleReason = errorsList?.[0]?.reason || errorData?.reason || e?.reason || '';
    let googleMessage = errorData?.message || e?.googleMessage || e?.message || '';

    // Inspect nested cause if present
    if (!googleReason && e?.cause) {
      googleReason = e.cause?.response?.data?.error?.errors?.[0]?.reason || e.cause?.reason || '';
    }

    const rawMessage = e?.message || '';
    const fullText = `${rawMessage} ${googleMessage} ${googleReason}`.toLowerCase();

    // Check 1: Destination Folder Child Limit Exceeded (numChildrenInNonRootLimitExceeded)
    if (
      googleReason === 'numChildrenInNonRootLimitExceeded' ||
      fullText.includes('numchildreninnonrootlimitexceeded') ||
      fullText.includes('limit for this folder\'s number of children') ||
      fullText.includes('folder\'s number of children')
    ) {
      return {
        classification: 'DESTINATION_FOLDER_CHILD_LIMIT',
        retryable: false,
        httpStatus: httpStatus || 403,
        googleReason: 'numChildrenInNonRootLimitExceeded',
        googleMessage: googleMessage || "The limit for this folder's number of children (files and folders) has been exceeded.",
        operation,
        sourceFileId,
        sourceFolderId,
        destinationFolderId,
        message: "Destination folder has exceeded Google's child-item limit (numChildrenInNonRootLimitExceeded)",
        originalError: e
      };
    }

    // Check 2: Rate Limit Exceeded
    const rateLimitReasons = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'domainCannotUseDrive', 'backendError']);
    if (
      httpStatus === 429 ||
      (httpStatus === 403 && rateLimitReasons.has(googleReason)) ||
      fullText.includes('ratelimitexceeded') ||
      fullText.includes('userratelimitexceeded') ||
      fullText.includes('user rate limit exceeded') ||
      fullText.includes('rate limit exceeded')
    ) {
      return {
        classification: 'RATE_LIMIT',
        retryable: true,
        httpStatus: httpStatus || 429,
        googleReason: googleReason || 'rateLimitExceeded',
        googleMessage,
        operation,
        sourceFileId,
        sourceFolderId,
        destinationFolderId,
        message: `Rate limit exceeded: ${googleMessage || rawMessage}`,
        originalError: e
      };
    }

    // Check 3: Storage Quota Exceeded
    if (
      googleReason === 'storageQuotaExceeded' ||
      googleReason === 'userStorageQuotaExceeded' ||
      fullText.includes('storagequotaexceeded') ||
      fullText.includes('quota exceeded')
    ) {
      return {
        classification: 'STORAGE_LIMIT',
        retryable: false,
        httpStatus: httpStatus || 403,
        googleReason: googleReason || 'storageQuotaExceeded',
        googleMessage,
        operation,
        sourceFileId,
        sourceFolderId,
        destinationFolderId,
        message: `Destination storage quota exceeded: ${googleMessage || rawMessage}`,
        originalError: e
      };
    }

    // Check 4: Authentication Failure
    if (httpStatus === 401 || fullText.includes('invalid credentials') || fullText.includes('token expired')) {
      return {
        classification: 'AUTHENTICATION_FAILURE',
        retryable: false,
        httpStatus: 401,
        googleReason: googleReason || 'authError',
        googleMessage,
        operation,
        sourceFileId,
        sourceFolderId,
        destinationFolderId,
        message: `Authentication failure: ${googleMessage || rawMessage}`,
        originalError: e
      };
    }

    // Check 5: Permission Denied
    if (
      httpStatus === 403 ||
      googleReason === 'insufficientFilePermissions' ||
      googleReason === 'cannotAccessFolder' ||
      fullText.includes('insufficient permissions')
    ) {
      return {
        classification: 'PERMISSION_DENIED',
        retryable: false,
        httpStatus: 403,
        googleReason: googleReason || 'insufficientFilePermissions',
        googleMessage,
        operation,
        sourceFileId,
        sourceFolderId,
        destinationFolderId,
        message: `Permission denied: ${googleMessage || rawMessage}`,
        originalError: e
      };
    }

    // Check 6: Invalid Parent / Not Found
    if (httpStatus === 404 || googleReason === 'notFound' || fullText.includes('file not found')) {
      return {
        classification: 'INVALID_PARENT',
        retryable: false,
        httpStatus: 404,
        googleReason: googleReason || 'notFound',
        googleMessage,
        operation,
        sourceFileId,
        sourceFolderId,
        destinationFolderId,
        message: `Resource not found: ${googleMessage || rawMessage}`,
        originalError: e
      };
    }

    // Check 7: Stream Interrupted / Stream Lifecycle Error
    if (
      fullText.includes('push() after eof') ||
      fullText.includes('err_stream_push_after_eof') ||
      fullText.includes('pipe is not a function') ||
      fullText.includes('upload_stream_type_error') ||
      e?.name === 'StreamLifecycleError' ||
      e?.name === 'UploadStreamTypeError'
    ) {
      return {
        classification: 'STREAM_INTERRUPTED',
        retryable: false,
        httpStatus,
        googleReason: googleReason || 'streamLifecycleError',
        googleMessage: rawMessage,
        operation,
        sourceFileId,
        sourceFolderId,
        destinationFolderId,
        message: `Stream interrupted: ${rawMessage}`,
        originalError: e
      };
    }

    // Check 8: Transient 5xx / Network Error
    const networkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'];
    const code = e?.code || e?.cause?.code;

    if (
      (httpStatus && httpStatus >= 500) ||
      (code && networkCodes.includes(code)) ||
      fullText.includes('socket hang up') ||
      fullText.includes('socket reset') ||
      fullText.includes('network socket reset') ||
      fullText.includes('econnreset') ||
      fullText.includes('etimedout')
    ) {
      return {
        classification: 'NETWORK_ERROR',
        retryable: true,
        httpStatus: httpStatus || 503,
        googleReason: googleReason || code || 'networkError',
        googleMessage: rawMessage,
        operation,
        sourceFileId,
        sourceFolderId,
        destinationFolderId,
        message: `Transient network error: ${rawMessage}`,
        originalError: e
      };
    }

    const isExplicitPermanent = !!(httpStatus && [400, 401, 403, 404].includes(httpStatus));

    return {
      classification: 'UNKNOWN',
      retryable: !isExplicitPermanent,
      httpStatus,
      googleReason,
      googleMessage,
      operation,
      sourceFileId,
      sourceFolderId,
      destinationFolderId,
      message: formatDetailedError(e),
      originalError: e
    };
  }
}
