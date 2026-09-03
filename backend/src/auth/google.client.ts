import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { tokenStore, AccountType } from './token.store';

export const PHOTOS_PICKER_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

export class GoogleClientManager {
  
  public getClient(): OAuth2Client {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI || 
      (process.env.NODE_ENV === 'production' 
        ? 'https://api.migration.ssrnservices.in/auth/google/callback'
        : 'http://localhost:3000/auth/google/callback');

    return new google.auth.OAuth2(clientId, clientSecret, redirectUri) as unknown as OAuth2Client;
  }

  public getAuthUrl(type: AccountType, customState?: string): string {
    const client = this.getClient();
    const stateValue = customState || type;

    let scopes: string[] = [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ];

    if (type === 'photos-source') {
      scopes = [
        PHOTOS_PICKER_SCOPE,
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ];
    }

    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      state: stateValue,
      include_granted_scopes: true,
      response_type: 'code',
      scope: scopes,
    });

    console.log(`\n=== OAuth URL Generation for ${type} ===`);
    console.log(`Redirect URI: ${process.env.GOOGLE_DRIVE_REDIRECT_URI}`);
    console.log(`Generated URL: ${url}\n`);
    
    return url;
  }

  public async getAuthenticatedClient(userId: string, type: AccountType): Promise<OAuth2Client | null> {
    const account = await tokenStore.getAccount(userId, type);
    if (!account) {
      console.warn(`[GoogleClient] No OAuthAccount record found for userId=${userId}, type=${type}`);
      return null;
    }

    const tokens = await tokenStore.getTokens(userId, type);
    if (!tokens || (!tokens.access_token && !tokens.refresh_token)) {
      console.warn(`[GoogleClient] Missing credentials for userId=${userId}, type=${type}`);
      return null;
    }

    const client = this.getClient();
    client.setCredentials(tokens);

    // Listen for automatic token refreshes and persist them immediately
    client.on('tokens', async (newTokens) => {
      console.log(`[GoogleClient] Tokens refreshed by OAuth library for userId=${userId}, type=${type}`);
      try {
        await tokenStore.saveTokens(userId, type, newTokens);
      } catch (err) {
        console.error(`[GoogleClient] Failed to persist refreshed tokens:`, err);
      }
    });

    // Check if access token is missing or expired
    const now = Date.now();
    const isExpired = !tokens.expiry_date || (tokens.expiry_date - now < 5 * 60 * 1000); // 5 min buffer

    if (isExpired && tokens.refresh_token) {
      console.log(`[GoogleClient] Access token expired or expiring soon for userId=${userId}, type=${type}. Attempting explicit refresh...`);
      try {
        const { credentials } = await client.refreshAccessToken();
        client.setCredentials(credentials);
        await tokenStore.saveTokens(userId, type, credentials);
        console.log(`[GoogleClient] Explicit token refresh successful for userId=${userId}, type=${type}`);
      } catch (refreshErr: any) {
        console.error(`[GoogleClient] Explicit token refresh failed for userId=${userId}, type=${type}:`, refreshErr.message);
        if (refreshErr.message?.includes('invalid_grant')) {
          return null; // Revoked or invalid refresh token
        }
      }
    }

    return client;
  }
}

export const googleClientManager = new GoogleClientManager();
