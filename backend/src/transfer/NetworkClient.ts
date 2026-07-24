// @ts-nocheck
import { google, drive_v3 } from 'googleapis';
import https from 'https';
import { googleClientManager } from '../auth/google.client';

export class NetworkClient {
  private static agent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 20,
    timeout: 60000 // 60s timeout
  });

  public static async getDriveClient(sessionId: string, type: 'source' | 'destination'): Promise<drive_v3.Drive> {
    const auth = await googleClientManager.getAuthenticatedClient(sessionId, type);
    if (!auth) throw new Error(`Account ${type} not authenticated`);
    
    // googleapis uses gaxios under the hood. We can set the default adapter options globally
    // or pass it into the drive instance. We'll set it on the drive instance.
    return google.drive({ 
      version: 'v3', 
      auth,
      httpAgent: this.agent,
    } as any);
  }

  public static isTransientError(e: any): boolean {
    const code = e?.code || e?.cause?.code;
    const status = e?.response?.status || e?.status;

    // Node network errors
    const transientCodes = ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'];
    if (code && transientCodes.includes(code)) return true;
    if (e.message && e.message.includes('socket hang up')) return true;
    if (e.message && e.message.includes('TLS')) return true;
    if (e.message && e.message.includes('ECONNRESET')) return true;

    // Google API transient errors
    if (status === 429) return true; // Rate limit
    if (status >= 500) return true; // 500, 502, 503, 504

    return false;
  }

  public static isPermanentError(e: any): boolean {
    const status = e?.response?.status || e?.status;
    if (status === 401 || status === 403 || status === 404) {
       // Note: 403 userRateLimitExceeded is transient, but standard 403 might be permanent
       if (e?.response?.data?.error?.errors?.[0]?.reason === 'userRateLimitExceeded') return false; // rate limit is transient
       if (e?.response?.data?.error?.errors?.[0]?.reason === 'rateLimitExceeded') return false;
       return true;
    }
    if (e.message && e.message.toLowerCase().includes('invalid credentials')) return true;
    if (e.message && e.message.toLowerCase().includes('permission denied')) return true;
    return false;
  }
}
