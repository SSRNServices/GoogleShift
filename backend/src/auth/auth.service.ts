import { google } from 'googleapis';
import { GaxiosError } from 'gaxios';
import { googleClientManager } from './google.client';
import { tokenStore, AccountType } from './token.store';

export enum ConnectionState {
  NOT_CONNECTED = 'NOT_CONNECTED',
  CONNECTED = 'CONNECTED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_REVOKED = 'TOKEN_REVOKED'
}

export interface ProfileResponse {
  state: ConnectionState;
  profile?: {
    email: string;
    name: string;
    picture: string;
    storage: {
      limit: number;
      used: number;
    }
  };
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class AuthService {
  private isTransientNetworkError(error: any): boolean {
    const transientCodes = ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'];
    return transientCodes.includes(error.code) || error.message?.includes('network timeout');
  }

  public async handleCallback(userId: string, type: AccountType, code: string): Promise<void> {
    const client = googleClientManager.getClient();
    let attempt = 1;
    const maxAttempts = 5;
    const baseDelay = 1000;

    while (attempt <= maxAttempts) {
      try {
        console.log(`\n[Auth Retry] Attempt ${attempt} to exchange authorization code for ${type}...`);
        
        // Exchange token
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);

        // Fetch basic google account info
        let email = '';
        let googleAccountId = '';
        try {
          const oauth2 = google.oauth2({ version: 'v2', auth: client as any });
          const userInfo = await oauth2.userinfo.get();
          email = userInfo.data.email || '';
          googleAccountId = userInfo.data.id || '';
        } catch (e) {
          console.warn(`[Auth] Could not fetch Google userinfo during callback:`, e);
        }
        
        // Persist tokens securely in TokenStore
        await tokenStore.saveTokens(userId, type, tokens, {
          email,
          googleAccountId,
          scopes: tokens.scope || undefined
        });
        
        if (attempt > 1) {
          console.log(`[Auth Retry] Success on attempt ${attempt}!`);
        }
        return; // Success, exit loop
        
      } catch (error: any) {
        if (error.name === 'NetworkError' || this.isTransientNetworkError(error)) {
          console.error(`[Auth Retry] Network Failure on attempt ${attempt}: ${error.message || error.code}`);
          
          if (attempt === maxAttempts) {
            throw new NetworkError('Unable to reach Google\'s OAuth servers after multiple attempts. Please check your internet connection or try again.');
          }
          
          const delay = baseDelay * Math.pow(2, attempt - 1);
          console.log(`[Auth Retry] Waiting ${delay}ms before retrying...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          attempt++;
        } else {
          console.error(`[Auth Error] Non-transient error occurred: ${error.message}`);
          throw error;
        }
      }
    }
  }

  public async getProfile(userId: string, type: AccountType): Promise<ProfileResponse> {
    const client = await googleClientManager.getAuthenticatedClient(userId, type);
    if (!client) {
      return { state: ConnectionState.NOT_CONNECTED };
    }

    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: client as any });
      const drive = google.drive({ version: 'v3', auth: client as any });

      const [userInfo, driveAbout] = await Promise.all([
        oauth2.userinfo.get(),
        drive.about.get({ fields: 'storageQuota' }),
      ]);

      const quota = (driveAbout.data as any).storageQuota;

      return {
        state: ConnectionState.CONNECTED,
        profile: {
          email: userInfo.data.email || '',
          name: userInfo.data.name || '',
          picture: userInfo.data.picture || '',
          storage: {
            limit: parseInt(quota?.limit || '0', 10),
            used: parseInt(quota?.usage || '0', 10),
          }
        }
      };
    } catch (error: any) {
      if (error instanceof GaxiosError) {
        const status = error.response?.status;
        const data = error.response?.data;
        
        if (status === 401 || status === 400) {
          if (data && data.error === 'invalid_grant') {
            return { state: ConnectionState.TOKEN_REVOKED };
          }
          return { state: ConnectionState.TOKEN_EXPIRED };
        }
      }
      
      console.error(`Unexpected error fetching profile for ${type}:`, error);
      throw error;
    }
  }

  public async logout(userId: string, type: AccountType) {
    // Optionally revoke the token from Google if we want to force re-consent, 
    // but usually just deleting from our store is enough for "logout".
    await tokenStore.deleteTokens(userId, type);
  }
}

export const authService = new AuthService();
