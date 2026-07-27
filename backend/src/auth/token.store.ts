import { Credentials } from 'google-auth-library';
import { prisma } from '../utils/database';

export type AccountType = 'source' | 'destination';

export interface TokenStore {
  saveTokens(userId: string, accountType: AccountType, tokens: Credentials): Promise<void>;
  getTokens(userId: string, accountType: AccountType): Promise<Credentials | null>;
  deleteTokens(userId: string, accountType: AccountType): Promise<void>;
}

export class DatabaseTokenStore implements TokenStore {
  
  private getProviderString(accountType: AccountType) {
    return `google-drive-${accountType}`;
  }

  async saveTokens(userId: string, accountType: AccountType, tokens: Credentials): Promise<void> {
    const provider = this.getProviderString(accountType);
    const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
    
    // We store additional credentials data inside refreshToken if needed,
    // but typically accessToken, refreshToken, and expiresAt are sufficient.
    await prisma.oAuthAccount.upsert({
      where: {
        provider_providerAccountId: {
          provider,
          providerAccountId: userId
        }
      },
      update: {
        accessToken: tokens.access_token || undefined,
        refreshToken: tokens.refresh_token || undefined,
        expiresAt
      },
      create: {
        userId,
        provider,
        providerAccountId: userId, // We map the internal user ID as the account ID for this provider
        accessToken: tokens.access_token || null,
        refreshToken: tokens.refresh_token || null,
        expiresAt
      }
    });
  }

  async getTokens(userId: string, accountType: AccountType): Promise<Credentials | null> {
    const provider = this.getProviderString(accountType);
    
    const account = await prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider,
          providerAccountId: userId
        }
      }
    });

    if (!account) return null;

    return {
      access_token: account.accessToken,
      refresh_token: account.refreshToken,
      expiry_date: account.expiresAt ? account.expiresAt.getTime() : null,
      token_type: 'Bearer'
    };
  }

  async deleteTokens(userId: string, accountType: AccountType): Promise<void> {
    const provider = this.getProviderString(accountType);
    
    try {
      await prisma.oAuthAccount.delete({
        where: {
          provider_providerAccountId: {
            provider,
            providerAccountId: userId
          }
        }
      });
    } catch (e) {
      // Ignore if doesn't exist
    }
  }
}

export const tokenStore = new DatabaseTokenStore();
