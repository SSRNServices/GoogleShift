import fs from 'fs';
import path from 'path';
import dns from 'dns';
import { promisify } from 'util';
import { google } from 'googleapis';
import { OAuth2Client, Credentials } from 'google-auth-library';
import { GaxiosError } from 'gaxios';

const resolveDns = promisify(dns.lookup);
const TOKENS_DIR = path.join(process.cwd(), 'tokens');

if (!fs.existsSync(TOKENS_DIR)) {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
}

export type AccountType = 'source' | 'destination';

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

export class OAuthService {
  private getClient(): OAuth2Client {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  private getTokenPath(type: AccountType): string {
    return path.join(TOKENS_DIR, `${type}.json`);
  }

  public getAuthUrl(type: AccountType): string {
    const client = this.getClient();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      state: type,
      scope: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
    });

    console.log(`\n=== OAuth URL Generation for ${type} ===`);
    console.log(`Redirect URI: ${process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback'}`);
    console.log(`State: ${type}`);
    console.log(`Generated URL: ${url}\n`);

    return url;
  }

  private async checkGoogleDNS(): Promise<void> {
    try {
      await resolveDns('oauth2.googleapis.com');
    } catch (error: any) {
      throw new NetworkError(`DNS resolution failed for oauth2.googleapis.com: ${error.message}`);
    }
  }

  private isTransientNetworkError(error: any): boolean {
    const transientCodes = ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'];
    return transientCodes.includes(error.code) || error.message?.includes('network timeout');
  }

  public async handleCallback(type: AccountType, code: string): Promise<void> {
    const client = this.getClient();
    let attempt = 1;
    const maxAttempts = 5;
    const baseDelay = 1000;

    while (attempt <= maxAttempts) {
      try {
        console.log(`\n[OAuth Retry] Attempt ${attempt} to exchange authorization code for ${type}...`);
        
        // 1. Verify DNS Reachability before exchanging
        await this.checkGoogleDNS();
        
        // 2. Exchange token
        const { tokens } = await client.getToken(code);
        
        // 3. Persist tokens
        fs.writeFileSync(this.getTokenPath(type), JSON.stringify(tokens, null, 2));
        
        if (attempt > 1) {
          console.log(`[OAuth Retry] Success on attempt ${attempt}!`);
        }
        return; // Success, exit loop
        
      } catch (error: any) {
        if (error.name === 'NetworkError' || this.isTransientNetworkError(error)) {
          console.error(`[OAuth Retry] Network Failure on attempt ${attempt}: ${error.message || error.code}`);
          
          if (attempt === maxAttempts) {
            throw new NetworkError('Unable to reach Google\'s OAuth servers after multiple attempts. Please check your internet connection or try again.');
          }
          
          const delay = baseDelay * Math.pow(2, attempt - 1);
          console.log(`[OAuth Retry] Waiting ${delay}ms before retrying...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          attempt++;
        } else {
          // If it's a legitimate Google API / OAuth error (e.g. invalid code), do not retry.
          console.error(`[OAuth Error] Non-transient error occurred: ${error.message}`);
          throw error;
        }
      }
    }
  }

  public getAuthenticatedClient(type: AccountType): OAuth2Client | null {
    const tokenPath = this.getTokenPath(type);
    if (!fs.existsSync(tokenPath)) {
      return null;
    }

    try {
      const tokens: Credentials = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
      const client = this.getClient();
      client.setCredentials(tokens);

      // Simple listener to persist refreshed tokens
      client.on('tokens', (newTokens) => {
        const currentTokens = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
        fs.writeFileSync(
          tokenPath,
          JSON.stringify({ ...currentTokens, ...newTokens }, null, 2)
        );
      });

      return client;
    } catch (e) {
      console.error(`Failed to load tokens for ${type}`, e);
      return null;
    }
  }

  public async getProfile(type: AccountType): Promise<ProfileResponse> {
    const client = this.getAuthenticatedClient(type);
    if (!client) {
      return { state: ConnectionState.NOT_CONNECTED };
    }

    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const drive = google.drive({ version: 'v3', auth: client });

      const [userInfo, driveAbout] = await Promise.all([
        oauth2.userinfo.get(),
        drive.about.get({ fields: 'storageQuota' }),
      ]);

      const quota = driveAbout.data.storageQuota;

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
      throw error; // Rethrow unexpected 500 errors
    }
  }

  public logout(type: AccountType) {
    const tokenPath = this.getTokenPath(type);
    if (fs.existsSync(tokenPath)) {
      fs.unlinkSync(tokenPath);
    }
  }
}

export const oauthService = new OAuthService();
