export enum PhotosErrorCode {
  PHOTOS_API_DISABLED = 'PHOTOS_API_DISABLED',
  PHOTOS_AUTH_REQUIRED = 'PHOTOS_AUTH_REQUIRED',
  PHOTOS_TOKEN_EXPIRED = 'PHOTOS_TOKEN_EXPIRED',
  PHOTOS_PICKER_SESSION_NOT_FOUND = 'PHOTOS_PICKER_SESSION_NOT_FOUND',
  PHOTOS_PERMISSION_DENIED = 'PHOTOS_PERMISSION_DENIED',
  PHOTOS_RATE_LIMITED = 'PHOTOS_RATE_LIMITED',
  PHOTOS_GOOGLE_API_ERROR = 'PHOTOS_GOOGLE_API_ERROR',
  PHOTOS_NETWORK_ERROR = 'PHOTOS_NETWORK_ERROR',
  PHOTOS_UNKNOWN_ERROR = 'PHOTOS_UNKNOWN_ERROR'
}

export interface ClassifiedError {
  code: PhotosErrorCode;
  statusCode: number;
  message: string;
  userMessage: string;
  projectId?: string;
  rawReason?: string;
}

export class GoogleApiErrorClassifier {
  public static classify(error: any): ClassifiedError {
    if (!error) {
      return {
        code: PhotosErrorCode.PHOTOS_UNKNOWN_ERROR,
        statusCode: 500,
        message: 'Unknown error occurred.',
        userMessage: 'An unexpected error occurred while communicating with Google.'
      };
    }

    // Inspect Axios / Google API response structures
    const response = error.response;
    const status = response?.status || error.statusCode || error.status;
    const data = response?.data;
    const errorDetails = data?.error;

    const rawMessage: string = (
      errorDetails?.message ||
      data?.message ||
      error.message ||
      String(error)
    );

    const reason: string = (
      errorDetails?.details?.[0]?.reason ||
      errorDetails?.errors?.[0]?.reason ||
      errorDetails?.status ||
      ''
    );

    // Extract Google Cloud project number if present in error message
    let projectId: string | undefined;
    const projectMatch = rawMessage.match(/project\s+(\d+)/i);
    if (projectMatch && projectMatch[1]) {
      projectId = projectMatch[1];
    } else {
      projectId = '636862284300';
    }

    const messageLower = rawMessage.toLowerCase();

    // 1. API DISABLED / NOT USED IN PROJECT
    if (
      messageLower.includes('has not been used in project') ||
      messageLower.includes('is disabled') ||
      messageLower.includes('photospicker.googleapis.com') ||
      messageLower.includes('accessnotconfigured') ||
      messageLower.includes('servicenotenabled') ||
      reason === 'SERVICE_DISABLED' ||
      reason === 'ACCESS_NOT_CONFIGURED'
    ) {
      return {
        code: PhotosErrorCode.PHOTOS_API_DISABLED,
        statusCode: 403,
        message: rawMessage,
        userMessage: `Google Photos Picker API (photospicker.googleapis.com) is not enabled for Google Cloud Project ${projectId}. Please enable the API in Google Cloud Console.`,
        projectId,
        rawReason: reason || 'SERVICE_DISABLED'
      };
    }

    // 2. INSUFFICIENT SCOPE / AUTH REQUIRED
    if (
      messageLower.includes('insufficient authentication scopes') ||
      messageLower.includes('insufficient_scope') ||
      messageLower.includes('photos_auth_required') ||
      reason === 'INSUFFICIENT_SCOPE'
    ) {
      return {
        code: PhotosErrorCode.PHOTOS_AUTH_REQUIRED,
        statusCode: 403,
        message: rawMessage,
        userMessage: 'Your Google Photos authorization is missing the required Photos Picker permission. Please reconnect Google Photos.',
        projectId,
        rawReason: reason || 'INSUFFICIENT_SCOPE'
      };
    }

    // 3. EXPIRED OR INVALID TOKEN
    if (
      status === 401 ||
      messageLower.includes('invalid_grant') ||
      messageLower.includes('token expired') ||
      messageLower.includes('unauthorized') ||
      reason === 'UNAUTHORIZED' ||
      reason === 'INVALID_CREDENTIALS'
    ) {
      return {
        code: PhotosErrorCode.PHOTOS_TOKEN_EXPIRED,
        statusCode: 401,
        message: rawMessage,
        userMessage: 'Your Google session has expired. Please reconnect Google Photos.',
        projectId,
        rawReason: reason || 'UNAUTHORIZED'
      };
    }

    // 4. RATE LIMITED / QUOTA EXCEEDED
    if (
      status === 429 ||
      messageLower.includes('rate limit') ||
      messageLower.includes('quota exceeded') ||
      reason === 'RATE_LIMIT_EXCEEDED' ||
      reason === 'USER_RATE_LIMIT_EXCEEDED'
    ) {
      return {
        code: PhotosErrorCode.PHOTOS_RATE_LIMITED,
        statusCode: 429,
        message: rawMessage,
        userMessage: 'Google Photos API rate limit reached. Please wait a moment and try again.',
        projectId,
        rawReason: reason || 'RATE_LIMIT_EXCEEDED'
      };
    }

    // 5. PICKER SESSION NOT FOUND (404)
    if (status === 404 || messageLower.includes('does not exist') || messageLower.includes('not found')) {
      return {
        code: PhotosErrorCode.PHOTOS_PICKER_SESSION_NOT_FOUND,
        statusCode: 404,
        message: rawMessage,
        userMessage: 'The requested Google Photos selection session was not found or has expired.',
        projectId,
        rawReason: reason || 'NOT_FOUND'
      };
    }

    // 6. PERMISSION DENIED
    if (status === 403) {
      return {
        code: PhotosErrorCode.PHOTOS_PERMISSION_DENIED,
        statusCode: 403,
        message: rawMessage,
        userMessage: 'Google Photos access was denied by Google. Please check your account permissions.',
        projectId,
        rawReason: reason || 'PERMISSION_DENIED'
      };
    }

    // 6. GOOGLE 5XX SERVICE ERROR
    if (status >= 500 && status < 600) {
      return {
        code: PhotosErrorCode.PHOTOS_GOOGLE_API_ERROR,
        statusCode: status,
        message: rawMessage,
        userMessage: 'Google Photos API experienced a temporary server error. Please try again.',
        projectId,
        rawReason: reason || 'GOOGLE_SERVER_ERROR'
      };
    }

    // 7. NETWORK ERROR
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return {
        code: PhotosErrorCode.PHOTOS_NETWORK_ERROR,
        statusCode: 503,
        message: rawMessage,
        userMessage: 'Network connection failed while reaching Google Photos API. Please check your connection.',
        projectId,
        rawReason: error.code
      };
    }

    return {
      code: PhotosErrorCode.PHOTOS_UNKNOWN_ERROR,
      statusCode: status || 500,
      message: rawMessage,
      userMessage: 'An unexpected error occurred while communicating with Google Photos.',
      projectId,
      rawReason: reason
    };
  }
}
