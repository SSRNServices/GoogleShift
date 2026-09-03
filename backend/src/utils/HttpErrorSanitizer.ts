/**
 * HTTP Error Sanitizer Utility
 * Ensures no sensitive credentials (bearer tokens, access tokens, refresh tokens,
 * client secrets, auth codes) are logged in error messages, stack traces, or Axios errors.
 */

export interface SanitizedErrorInfo {
  message: string;
  status?: number;
  code?: string;
  url?: string;
  method?: string;
  googleReason?: string;
}

export class HttpErrorSanitizer {
  private static readonly CREDENTIAL_PATTERNS = [
    /Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/gi,
    /access_token["']?\s*[:=]\s*["']?[A-Za-z0-9\-\._~\+\/]+["']?/gi,
    /refresh_token["']?\s*[:=]\s*["']?[A-Za-z0-9\-\._~\+\/]+["']?/gi,
    /client_secret["']?\s*[:=]\s*["']?[A-Za-z0-9\-\._~\+\/]+["']?/gi,
    /code=["']?[A-Za-z0-9\-\._~\+\/]+["']?/gi,
    /Authorization:\s*Bearer\s+[^\s"']+/gi
  ];

  /**
   * Sanitizes a string message by replacing all credential patterns with [REDACTED].
   */
  public static sanitizeString(str: string): string {
    if (!str) return str;
    let sanitized = str;
    for (const pattern of this.CREDENTIAL_PATTERNS) {
      sanitized = sanitized.replace(pattern, (match) => {
        if (match.toLowerCase().startsWith('authorization:')) {
          return 'Authorization: [REDACTED]';
        }
        if (match.toLowerCase().startsWith('bearer')) {
          return 'Bearer [REDACTED]';
        }
        const key = match.split(/[:=]/)[0];
        return `${key}=[REDACTED]`;
      });
    }
    return sanitized;
  }

  /**
   * Extracts clean, safe error information from an Error or Axios/Gaxios error object.
   */
  public static extractSanitizedInfo(error: any): SanitizedErrorInfo {
    if (!error) {
      return { message: 'Unknown error' };
    }

    const status = error.response?.status || error.status || error.code;
    const method = error.config?.method?.toUpperCase() || error.request?.method;
    
    // Redact URL if present
    let rawUrl = error.config?.url || error.request?.url || '';
    if (rawUrl) {
      rawUrl = rawUrl.replace(/code=[^&]+/g, 'code=[REDACTED]')
                     .replace(/access_token=[^&]+/g, 'access_token=[REDACTED]');
    }

    // Google API error structure
    const googleData = error.response?.data;
    let googleReason = undefined;
    if (googleData) {
      if (typeof googleData.error === 'string') {
        googleReason = googleData.error;
      } else if (googleData.error?.message) {
        googleReason = googleData.error.message;
      } else if (googleData.error_description) {
        googleReason = googleData.error_description;
      }
    }

    const rawMessage = error.message || (typeof error === 'string' ? error : 'Internal Error');
    const sanitizedMessage = this.sanitizeString(rawMessage);

    return {
      message: googleReason ? `${sanitizedMessage} (${this.sanitizeString(googleReason)})` : sanitizedMessage,
      status: typeof status === 'number' ? status : undefined,
      code: error.code || (typeof status === 'string' ? status : undefined),
      url: rawUrl || undefined,
      method: method || undefined,
      googleReason: googleReason ? this.sanitizeString(googleReason) : undefined
    };
  }

  /**
   * Safe log helper for errors.
   */
  public static logError(context: string, error: any): void {
    const info = this.extractSanitizedInfo(error);
    console.error(`[${context}] Error | Status: ${info.status || 'N/A'} | Code: ${info.code || 'N/A'} | URL: ${info.url || 'N/A'} | Message: ${info.message}`);
  }
}
