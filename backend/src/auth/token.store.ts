import { Credentials } from 'google-auth-library';
import { prisma } from '../utils/database';

export type AccountType = 'source' | 'destination' | 'photos-source' | 'photos-destination';

export interface TokenStore {
  saveTokens(userId: string, accountType: AccountType, tokens: Credentials, accountInfo?: { email?: string; googleAccountId?: string; scopes?: string }): Promise<void>;
  getTokens(userId: string, accountType: AccountType): Promise<Credentials | null>;
  getAccount(userId: string, accountType: AccountType): Promise<any | null>;
  deleteTokens(userId: string, accountType: AccountType): Promise<void>;
}

export class DatabaseTokenStore implements TokenStore {
  
  private getProviderString(accountType: AccountType) {
    if (accountType.startsWith('photos-')) {
      return `google-${accountType}`;
    }
    return `google-drive-${accountType}`;
  }

  async saveTokens(
    userId: string, 
    accountType: AccountType, 
    tokens: Credentials, 
    accountInfo?: { email?: string; googleAccountId?: string; scopes?: string }
  ): Promise<void> {
    const provider = this.getProviderString(accountType);
    const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
    
    console.log(`[OAuthAudit] ACCOUNT_LOOKUP | Provider: ${provider} | UserId: ${userId}`);
    const existing = await prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider,
          providerAccountId: userId
        }
      }
    });

    const isUpdate = !!existing;
    if (isUpdate) {
      console.log(`[OAuthAudit] ACCOUNT_UPDATE | Provider: ${provider} | UserId: ${userId} | ExistingId: ${existing.id}`);
    } else {
      console.log(`[OAuthAudit] ACCOUNT_CREATE | Provider: ${provider} | UserId: ${userId}`);
    }

    const refreshTokenToSave = tokens.refresh_token ?? existing?.refreshToken ?? null;
    const accessTokenToSave = tokens.access_token ?? existing?.accessToken ?? null;
    const scopesToSave = tokens.scope ?? accountInfo?.scopes ?? existing?.scopes ?? null;
    const emailToSave = accountInfo?.email ?? existing?.email ?? null;
    const googleAccountIdToSave = accountInfo?.googleAccountId ?? existing?.googleAccountId ?? null;

    const saved = await prisma.oAuthAccount.upsert({
      where: {
        provider_providerAccountId: {
          provider,
          providerAccountId: userId
        }
      },
      update: {
        accessToken: accessTokenToSave,
        refreshToken: refreshTokenToSave,
        expiresAt,
        ...(emailToSave ? { email: emailToSave } : {}),
        ...(googleAccountIdToSave ? { googleAccountId: googleAccountIdToSave } : {}),
        ...(scopesToSave ? { scopes: scopesToSave } : {}),
        updatedAt: new Date()
      },
      create: {
        userId,
        provider,
        providerAccountId: userId,
        email: emailToSave,
        googleAccountId: googleAccountIdToSave,
        accessToken: accessTokenToSave,
        refreshToken: refreshTokenToSave,
        expiresAt,
        scopes: scopesToSave
      }
    });

    console.log(`[OAuthAudit] TOKEN_SAVE | Provider: ${provider} | UserId: ${userId} | AccountId: ${saved.id} | Email: ${emailToSave || 'N/A'} | HasRefreshToken: ${!!refreshTokenToSave}`);
  }

  async getTokens(userId: string, accountType: AccountType): Promise<Credentials | null> {
    const account = await this.getAccount(userId, accountType);
    if (!account) return null;

    return {
      access_token: account.accessToken,
      refresh_token: account.refreshToken,
      expiry_date: account.expiresAt ? account.expiresAt.getTime() : null,
      token_type: 'Bearer',
      scope: account.scopes || undefined
    };
  }

  async getAccount(userId: string, accountType: AccountType): Promise<any | null> {
    const provider = this.getProviderString(accountType);
    
    return prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider,
          providerAccountId: userId
        }
      }
    });
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
