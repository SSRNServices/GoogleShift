import { Credentials } from 'google-auth-library';

export type AccountType = 'source' | 'destination';

export interface TokenStore {
  saveTokens(sessionId: string, accountType: AccountType, tokens: Credentials): Promise<void>;
  getTokens(sessionId: string, accountType: AccountType): Promise<Credentials | null>;
  deleteTokens(sessionId: string, accountType: AccountType): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  // Map of sessionId -> { source: Credentials, destination: Credentials }
  private store: Map<string, { source?: Credentials; destination?: Credentials }> = new Map();

  async saveTokens(sessionId: string, accountType: AccountType, tokens: Credentials): Promise<void> {
    const sessionData = this.store.get(sessionId) || {};
    sessionData[accountType] = tokens;
    this.store.set(sessionId, sessionData);
  }

  async getTokens(sessionId: string, accountType: AccountType): Promise<Credentials | null> {
    const sessionData = this.store.get(sessionId);
    return sessionData?.[accountType] || null;
  }

  async deleteTokens(sessionId: string, accountType: AccountType): Promise<void> {
    const sessionData = this.store.get(sessionId);
    if (sessionData) {
      delete sessionData[accountType];
      this.store.set(sessionId, sessionData);
    }
  }
}

export const tokenStore = new MemoryTokenStore();
