export class RetryHelper {
  private static isTransientError(e: any): boolean {
    const code = e?.code || e?.cause?.code;
    const status = e?.response?.status || e?.status;

    // Node network errors
    const transientCodes = ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'SQLITE_BUSY', 'SQLITE_LOCKED'];
    if (code && transientCodes.includes(code)) return true;
    if (e.message && e.message.includes('socket hang up')) return true;
    if (e.message && e.message.includes('TLS')) return true;
    if (e.message && e.message.includes('SQLITE_BUSY')) return true;

    // Google API transient errors
    if (status === 429) return true; // Rate limit
    if (status >= 500) return true; // 500, 502, 503, 504

    return false;
  }

  private static isPermanentError(e: any): boolean {
    const status = e?.response?.status || e?.status;
    if (status === 401 || status === 403 || status === 404 || status === 400) {
      if (status === 403 && (e.message?.includes('Rate limit') || e.message?.includes('User rate limit exceeded'))) {
         return false; // Actually transient
      }
      return true;
    }
    if (e.message && e.message.includes('invalid credentials')) return true;
    return false;
  }

  public static async withRetry<T>(
      operationName: string, 
      operation: () => Promise<T>, 
      logFn?: (msg: string) => void,
      onRateLimit?: () => void
  ): Promise<T> {
    const backoffs = [1, 2, 4, 8, 16]; // in seconds
    const maxRetries = 5;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (e: any) {
        if (this.isPermanentError(e)) {
          throw e; // Do not retry permanent errors
        }
        
        if (this.isTransientError(e) || (e.response?.status === 403 && e.message?.includes('User rate limit exceeded'))) {
          if (attempt === maxRetries - 1) throw e;
          
          if (e.response?.status === 429 || (e.response?.status === 403 && e.message?.includes('rate limit'))) {
             if (onRateLimit) onRateLimit();
          }
          
          const delaySecs = backoffs[Math.min(attempt, backoffs.length - 1)] || 16;
          const jitter = Math.random() * 1000;
          const delayMs = delaySecs * 1000 + jitter;

          if (logFn) logFn(`[${operationName}] Network error (${e.code || e.status || '403 Rate Limit'}). Retrying (${attempt + 1}/${maxRetries}) in ${delaySecs}s...`);
          
          await new Promise(res => setTimeout(res, delayMs));
          
          if (logFn) logFn(`Resuming ${operationName}...`);
        } else {
          throw e; // Unknown error, bubble up
        }
      }
    }
    throw new Error('Unreachable');
  }
}
