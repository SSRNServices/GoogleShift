// @ts-nocheck
import { google, drive_v3 } from 'googleapis';
import https from 'https';
import { googleClientManager } from '../auth/google.client';

export class NetworkClient {
  private static agent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 50,
    freeSocketTimeout: 30000,
    timeout: 60000 // 60s timeout
  });

  private static clientCache: Map<string, { drive: drive_v3.Drive; cachedAt: number }> = new Map();

  public static clearClientCache(identifier?: string): void {
    if (identifier) {
      this.clientCache.delete(`${identifier}:source`);
      this.clientCache.delete(`${identifier}:destination`);
    } else {
      this.clientCache.clear();
    }
  }

  public static async getDriveClient(sessionIdOrUserId: string, type: 'source' | 'destination'): Promise<drive_v3.Drive> {
    const cacheKey = `${sessionIdOrUserId}:${type}`;
    const cached = this.clientCache.get(cacheKey);
    const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes TTL

    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
      return cached.drive;
    }

    const { prisma } = await import('../utils/database');
    const { tokenStore } = await import('../auth/token.store');

    let userId = sessionIdOrUserId;
    let sessionId: string | null = null;

    // Check if sessionIdOrUserId is a MigrationSession ID
    try {
      const session = await prisma.migrationSession.findUnique({
        where: { id: sessionIdOrUserId }
      });
      if (session) {
        sessionId = session.id;
        userId = session.ownerId;
      }
    } catch (e) {
      // Ignore lookup error and fall back to using sessionIdOrUserId as userId
    }

    console.log(`[NetworkClient] Resolving ${type} credentials | Identifier: ${sessionIdOrUserId} -> UserID: ${userId} | SessionID: ${sessionId || 'N/A'}`);

    const account = await tokenStore.getAccount(userId, type);
    const hasRefreshToken = !!account?.refreshToken;
    const hasAccessToken = !!account?.accessToken;
    const isExpired = account?.expiresAt ? account.expiresAt.getTime() < Date.now() : true;

    console.log(`[NetworkClient Diagnostic] Provider: DatabaseTokenStore | Type: ${type} | UserID: ${userId} | SessionID: ${sessionId || 'N/A'} | HasAccessToken: ${hasAccessToken} | HasRefreshToken: ${hasRefreshToken} | TokenExpired: ${isExpired}`);

    const auth = await googleClientManager.getAuthenticatedClient(userId, type);
    if (!auth) {
      console.error(`[NetworkClient FATAL] Account ${type} not authenticated | UserID: ${userId} | SessionID: ${sessionId || 'N/A'}`);
      throw new Error(`Account ${type} not authenticated. Please reconnect ${type} account.`);
    }

    const driveClient = google.drive({ 
      version: 'v3', 
      auth,
      httpAgent: this.agent,
      httpsAgent: this.agent,
      options: {
        agent: this.agent,
        httpsAgent: this.agent
      }
    } as any);

    this.clientCache.set(cacheKey, { drive: driveClient, cachedAt: Date.now() });
    if (sessionId && sessionId !== sessionIdOrUserId) {
      this.clientCache.set(`${sessionId}:${type}`, { drive: driveClient, cachedAt: Date.now() });
    }

    return driveClient;
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
