// @ts-nocheck
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { tokenStore, AccountType } from './token.store';

export class GoogleClientManager {
  
  public getClient(): OAuth2Client {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  public getAuthUrl(type: AccountType): string {
    const client = this.getClient();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      state: type,
      include_granted_scopes: true,
      response_type: 'code',
      scope: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
    });

    console.log(`\n=== OAuth URL Generation for ${type} ===`);
    console.log(`Redirect URI: ${process.env.GOOGLE_DRIVE_REDIRECT_URI}`);
    console.log(`Generated URL: ${url}\n`);

    return url;
  }

  public async getAuthenticatedClient(sessionId: string, type: AccountType): Promise<OAuth2Client | null> {
    const tokens = await tokenStore.getTokens(sessionId, type);
    if (!tokens) {
      return null;
    }

    const client = this.getClient();
    client.setCredentials(tokens);

    // Listen for automatic token refreshes and persist them
    client.on('tokens', async (newTokens) => {
      console.log(`[GoogleClient] Tokens refreshed for ${type}`);
      const currentTokens = await tokenStore.getTokens(sessionId, type) || {};
      await tokenStore.saveTokens(sessionId, type, { ...currentTokens, ...newTokens });
    });

    return client;
  }
}

export const googleClientManager = new GoogleClientManager();
