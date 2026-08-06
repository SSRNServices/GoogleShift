import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authController } from '../src/auth/auth.controller';
import { authService } from '../src/auth/auth.service';
import { googleClientManager } from '../src/auth/google.client';
import { tokenStore } from '../src/auth/token.store';
import { prisma } from '../src/utils/database';
import jwt from 'jsonwebtoken';

vi.mock('../src/utils/database', () => ({
  prisma: {
    user: {
      findUnique: vi.fn()
    },
    oAuthAccount: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn()
    },
    migrationSession: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    }
  }
}));

vi.mock('passport', () => ({
  default: {
    authenticate: vi.fn().mockImplementation((strategy, callback) => {
      return (req: any, res: any, next: any) => {
        if (callback) {
          callback(null, { id: 'passport-user-1', email: 'passport@example.com', role: 'USER' });
        }
      };
    })
  }
}));

vi.mock('../src/auth/google.client', () => ({
  googleClientManager: {
    getClient: vi.fn().mockReturnValue({
      getToken: vi.fn().mockResolvedValue({
        tokens: {
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
          expiry_date: Date.now() + 3600 * 1000,
          scope: 'drive'
        }
      }),
      setCredentials: vi.fn()
    }),
    getAuthenticatedClient: vi.fn().mockResolvedValue({})
  }
}));

describe('OAuth Callback & Reconnection Test Suite', () => {
  const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_development';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockReqRes = (query: Record<string, any>, cookies: Record<string, any> = {}, user?: any) => {
    const req: any = {
      query,
      cookies,
      user,
      originalUrl: '/auth/google/callback'
    };

    const res: any = {
      redirect: vi.fn(),
      cookie: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };

    const next = vi.fn();
    return { req, res, next };
  };

  it('1. First connection for source drive account redirects to dashboard with connected=source', async () => {
    const mockUser = { id: 'user-1', email: 'test@example.com', status: 'ACTIVE', isActive: true, role: 'USER' };
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
    vi.mocked(prisma.oAuthAccount.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue({ id: 'oauth-acc-1' } as any);

    const state = Buffer.from(JSON.stringify({ type: 'source', userId: 'user-1', ts: Date.now() })).toString('base64url');
    const { req, res, next } = createMockReqRes({ code: 'valid-auth-code', state });

    await authController.handleGoogleCallback(req, res, next);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(prisma.oAuthAccount.upsert).toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/dashboard?connected=source'));
  });

  it('2. Reconnecting source drive account updates token and preserves existing refresh token if Google returns none', async () => {
    const mockUser = { id: 'user-1', email: 'test@example.com', status: 'ACTIVE', isActive: true, role: 'USER' };
    const existingAccount = {
      id: 'oauth-acc-1',
      userId: 'user-1',
      provider: 'google-drive-source',
      providerAccountId: 'user-1',
      accessToken: 'old-access-token',
      refreshToken: 'existing-persistent-refresh-token'
    };

    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
    vi.mocked(prisma.oAuthAccount.findUnique).mockResolvedValue(existingAccount as any);
    vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue(existingAccount as any);

    // Mock Google returning ONLY access token on reconnect (no new refresh token)
    const mockClient = {
      getToken: vi.fn().mockResolvedValue({
        tokens: {
          access_token: 'new-access-token-without-refresh-token',
          expiry_date: Date.now() + 3600 * 1000
        }
      }),
      setCredentials: vi.fn()
    };
    vi.mocked(googleClientManager.getClient).mockReturnValue(mockClient as any);

    const state = Buffer.from(JSON.stringify({ type: 'source', userId: 'user-1', ts: Date.now() })).toString('base64url');
    const { req, res, next } = createMockReqRes({ code: 'reconnect-code', state });

    await authController.handleGoogleCallback(req, res, next);

    expect(prisma.oAuthAccount.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          accessToken: 'new-access-token-without-refresh-token',
          refreshToken: 'existing-persistent-refresh-token' // MUST preserve existing refresh token!
        })
      })
    );
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/dashboard?connected=source'));
  });

  it('3. Reconnecting destination drive account after migration completed succeeds without HTTP 500', async () => {
    const mockUser = { id: 'user-1', email: 'test@example.com', status: 'ACTIVE', isActive: true, role: 'USER' };
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
    vi.mocked(prisma.oAuthAccount.findUnique).mockResolvedValue({ id: 'dest-acc' } as any);
    vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue({ id: 'dest-acc' } as any);
    vi.mocked(prisma.migrationSession.findFirst).mockResolvedValue({ id: 'session-old', migrationStatus: 'COMPLETED' } as any);

    const state = Buffer.from(JSON.stringify({ type: 'destination', userId: 'user-1', ts: Date.now() })).toString('base64url');
    const { req, res, next } = createMockReqRes({ code: 'dest-reconnect-code', state });

    await authController.handleGoogleCallback(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/dashboard?connected=destination'));
  });

  it('4. Extracted userId from accessToken cookie when req.user and state.userId are absent', async () => {
    const mockUser = { id: 'user-from-cookie', email: 'cookie@example.com', status: 'ACTIVE', isActive: true, role: 'USER' };
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
    vi.mocked(prisma.oAuthAccount.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue({ id: 'acc-1' } as any);

    const cookieToken = jwt.sign({ userId: 'user-from-cookie' }, JWT_SECRET);
    // Plain string state without embedded userId
    const { req, res, next } = createMockReqRes({ code: 'code-cookie', state: 'destination' }, { accessToken: cookieToken });

    await authController.handleGoogleCallback(req, res, next);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-from-cookie' } });
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/dashboard?connected=destination'));
  });

  it('5. Handles invalid / malformed OAuth state gracefully by redirecting to dashboard error instead of HTTP 500', async () => {
    const { req, res, next } = createMockReqRes({ code: 'code-bad-state', state: 'bad_unrecognized_state_payload' });

    await authController.handleGoogleCallback(req, res, next);

    // Should NOT crash or throw 500, but delegate or redirect safely
    expect(res.redirect).toHaveBeenCalled();
  });

  it('6. Handles missing user / unauthenticated state safely by redirecting to login page', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    const state = Buffer.from(JSON.stringify({ type: 'source', userId: 'non-existent-user', ts: Date.now() })).toString('base64url');
    const { req, res, next } = createMockReqRes({ code: 'some-code', state });

    await authController.handleGoogleCallback(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/login?error=user_inactive'));
  });

  it('7. Handles Google OAuth error param gracefully', async () => {
    const { req, res, next } = createMockReqRes({ error: 'access_denied' });

    await authController.handleGoogleCallback(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/dashboard?error=auth_failed'));
  });
});
