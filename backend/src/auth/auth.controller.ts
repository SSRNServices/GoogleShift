import { Request, Response } from 'express';
import passport from 'passport';
import { googleClientManager } from './google.client';
import { authService, ConnectionState } from './auth.service';
import { AccountType } from './token.store';
import { prisma } from '../utils/database';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getConfig } from '../config/config';

const getJwtSecret = () => getConfig().JWT_SECRET;
const getRefreshSecret = () => getConfig().JWT_SECRET;

export class AuthController {
  
  // ==========================================
  // USER AUTHENTICATION (JWT)
  // ==========================================

  public signup = async (req: Request, res: Response): Promise<void> => {
    try {
      const { firstName, lastName, email, password } = req.body;
      
      if (!email || !password || !firstName || !lastName) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
      }
      
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        res.status(409).json({ error: 'Email already exists' });
        return;
      }
      
      const passwordHash = await bcrypt.hash(password, 10);
      const name = `${firstName} ${lastName}`;
      
      const user = await prisma.user.create({
        data: {
          email,
          name,
          passwordHash,
          status: 'ACTIVE', // Automatically active for now
          role: 'USER'
        }
      });
      
      this.issueTokens(user, res);
    } catch (error) {
      console.error('Signup error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  public login = async (req: Request, res: Response): Promise<void> => {
    try {
      const { email, password } = req.body;
      
      if (!email || !password) {
        res.status(400).json({ error: 'Missing credentials' });
        return;
      }
      
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash || user.status !== 'ACTIVE' || !user.isActive) {
        res.status(401).json({ error: 'Invalid credentials or inactive account' });
        return;
      }
      
      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() }
      });
      
      this.issueTokens(user, res);
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  public logoutUser = async (req: Request, res: Response): Promise<void> => {
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');
    res.json({ success: true });
  };

  public refresh = async (req: Request, res: Response): Promise<void> => {
    try {
      const { refreshToken: tokenFromBody } = req.body || {};
      const refreshToken = tokenFromBody || req.cookies?.refreshToken;

      if (!refreshToken) {
        console.warn('[AUTH REFRESH 401] No refresh token provided in body or cookies.');
        res.status(401).json({ error: 'No refresh token provided' });
        return;
      }
      
      const decoded = jwt.verify(refreshToken, getRefreshSecret()) as any;
      const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
      
      if (!user || user.status !== 'ACTIVE' || !user.isActive) {
        console.warn(`[AUTH REFRESH 401] Invalid user state for ID ${decoded?.userId}`);
        res.status(401).json({ error: 'Invalid refresh token or inactive account' });
        return;
      }

      console.log(`[AUTH REFRESH 200] Successfully refreshed tokens for user ${user.email} (${user.id})`);
      this.issueTokens(user, res);
    } catch (error: any) {
      console.warn(`[AUTH REFRESH 401] Token verification failed: ${error.message}`);
      res.status(401).json({ error: 'Invalid refresh token', message: error.message });
    }
  };

  public getMe = async (req: Request, res: Response): Promise<void> => {
    // Current user is attached by requireUserAuth middleware
    res.json({ authenticated: true, user: (req as any).user });
  };

  private getFrontendUrl(): string {
    return process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' 
      ? 'https://migration.ssrnservices.in' 
      : 'http://localhost:5173');
  }

  private getCookieDomain(): string | undefined {
    if (process.env.COOKIE_DOMAIN) return process.env.COOKIE_DOMAIN;
    if (process.env.NODE_ENV !== 'production') return undefined;
    const targetUrl = process.env.FRONTEND_URL || process.env.BACKEND_URL || '';
    try {
      const hostname = new URL(targetUrl).hostname;
      const parts = hostname.split('.');
      if (parts.length >= 2) {
        return `.${parts.slice(-2).join('.')}`;
      }
      return hostname;
    } catch (_) {
      return undefined;
    }
  }

  private issueTokens(user: any, res: Response) {
    const payload = { userId: user.id, email: user.email, role: user.role };
    const accessToken = jwt.sign(payload, getJwtSecret(), { expiresIn: '1h' });
    const refreshToken = jwt.sign(payload, getRefreshSecret(), { expiresIn: '7d' });
    
    // Omit passwordHash before sending
    const { passwordHash, ...userWithoutPassword } = user;
    
    const domain = this.getCookieDomain();

    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: (process.env.NODE_ENV === 'production' ? 'none' as const : 'lax' as const),
      ...(domain ? { domain } : {})
    };

    res.cookie('accessToken', accessToken, {
      ...cookieOptions,
      maxAge: 60 * 60 * 1000 // 1 hour
    });
    
    res.cookie('refreshToken', refreshToken, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    
    res.json({
      accessToken,
      refreshToken,
      user: userWithoutPassword
    });
  }

  // ==========================================
  // ==========================================
  // GOOGLE DRIVE & USER OAUTH
  // ==========================================

  public getAuthUrl = (type: AccountType, req: Request, res: Response): void => {
    const frontendUrl = this.getFrontendUrl();
    const validTypes: AccountType[] = ['source', 'destination', 'photos-source', 'photos-destination'];
    if (!validTypes.includes(type)) {
      res.redirect(`${frontendUrl}/dashboard?error=invalid_type&reason=${encodeURIComponent('Invalid account type')}`);
      return;
    }

    const userId = (req as any).user?.id;
    if (!userId) {
      res.redirect(`${frontendUrl}/login?error=auth_required`);
      return;
    }

    const statePayload = Buffer.from(JSON.stringify({
      type,
      userId,
      ts: Date.now()
    })).toString('base64url');

    const url = googleClientManager.getAuthUrl(type, statePayload);
    res.redirect(url);
  };

  public handleGoogleCallback = async (req: Request, res: Response, next: any): Promise<void> => {
    const frontendUrl = this.getFrontendUrl();
    const code = req.query.code as string;
    const rawState = req.query.state as string;
    const errorParam = req.query.error as string;

    const sanitizedUrl = (req.originalUrl || req.url || '').replace(/code=[^&]+/g, 'code=[REDACTED]');
    console.log(`\n================================================================================`);
    console.log(`[OAuthAudit] CALLBACK_RECEIVED | CodePresent: ${!!code} | StatePresent: ${!!rawState} | ErrorParam: ${errorParam || 'none'} | URL: ${sanitizedUrl}`);
    console.log(`================================================================================\n`);

    if (errorParam) {
      console.error(`[OAuthAudit] ERROR | Google OAuth returned error param: ${errorParam}`);
      res.redirect(`${frontendUrl}/dashboard?error=auth_failed&reason=${encodeURIComponent(`Google OAuth error: ${errorParam}`)}`);
      return;
    }

    if (!code) {
      console.error(`[OAuthAudit] ERROR | Missing authorization code parameter`);
      res.redirect(`${frontendUrl}/dashboard?error=auth_failed&reason=${encodeURIComponent('Missing authorization code')}`);
      return;
    }

    // Decode state to determine if this is Drive OAuth or Passport User Sign-In
    let type: AccountType | null = null;
    let stateUserId: string | null = null;
    let decodedStateObj: any = null;

    const validTypes: AccountType[] = ['source', 'destination', 'photos-source', 'photos-destination'];
    if (rawState) {
      if (validTypes.includes(rawState as AccountType)) {
        type = rawState as AccountType;
        console.log(`[OAuthAudit] STATE_DECODE | Plain string state detected: ${type}`);
      } else {
        try {
          decodedStateObj = JSON.parse(Buffer.from(rawState, 'base64url').toString('utf8'));
          console.log(`[OAuthAudit] STATE_DECODE | JSON state decoded:`, JSON.stringify(decodedStateObj));
          if (validTypes.includes(decodedStateObj.type as AccountType)) {
            type = decodedStateObj.type as AccountType;
            stateUserId = decodedStateObj.userId || null;
          }
        } catch (e: any) {
          console.warn(`[OAuthAudit] STATE_DECODE | Non-JSON state payload: ${rawState} | Error: ${e.message}`);
        }
      }
    }

    // If state contains a Drive OAuth connection request
    if (type) {
      console.log(`[OAuthAudit] STATE_VALIDATED | Mode: ${type} | StateUserId: ${stateUserId || 'N/A'}`);

      try {
        // Robust userId extraction
        let userId: string | null = (req as any).user?.id || stateUserId;

        if (!userId && req.cookies?.accessToken) {
          try {
            const decodedJwt = jwt.verify(req.cookies.accessToken, getJwtSecret()) as any;
            if (decodedJwt?.userId) {
              userId = decodedJwt.userId;
              console.log(`[OAuthAudit] SESSION_FOUND | Extracted userId ${userId} from accessToken cookie`);
            }
          } catch (jwtErr: any) {
            console.warn(`[OAuthAudit] JWT Cookie verification failed during callback: ${jwtErr.message}`);
          }
        }

        if (!userId) {
          console.error(`[OAuthAudit] ERROR | Missing user ID for Drive connection (${type})`);
          res.redirect(`${frontendUrl}/login?error=auth_required`);
          return;
        }

        // Validate user existence in DB
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || user.status === 'PENDING' || !user.isActive) {
          console.error(`[OAuthAudit] ERROR | User not found or inactive in DB: ${userId}`);
          res.redirect(`${frontendUrl}/login?error=user_inactive`);
          return;
        }

        console.log(`[OAuthAudit] USER_FOUND | UserId: ${user.id} | Email: ${user.email} | Role: ${user.role}`);

        // Perform token exchange & token store persistence
        await authService.handleCallback(userId, type, code);

        // Update active migration session if applicable
        try {
          const activeSession = await prisma.migrationSession.findFirst({
            where: { ownerId: userId },
            orderBy: { createdAt: 'desc' }
          });
          if (activeSession) {
            console.log(`[OAuthAudit] SESSION_UPDATE | Updating migration session ${activeSession.id} for ${type}`);
          }
        } catch (sessionErr: any) {
          console.warn(`[OAuthAudit] Session update warning (non-fatal): ${sessionErr.message}`);
        }

        // Fetch profile optional step
        let profileEmail = '';
        try {
          const profileResponse = await authService.getProfile(userId, type);
          profileEmail = profileResponse.profile?.email || '';
          console.log(`[OAuthAudit] Profile fetched for ${type}: Email=${profileEmail}`);
        } catch (pErr: any) {
          console.warn(`[OAuthAudit] Post-OAuth getProfile warning (non-fatal): ${pErr.message}`);
        }

        const redirectUrl = type === 'photos-source'
          ? `${frontendUrl}/migration?photosAuth=success`
          : `${frontendUrl}/dashboard?connected=${type}`;
        console.log(`[OAuthAudit] FRONTEND_REDIRECT | Redirecting to ${redirectUrl}`);
        console.log(`[OAuthAudit] CALLBACK_COMPLETE | Mode: ${type} | UserId: ${userId} | Success`);
        
        res.redirect(redirectUrl);
        return;
      } catch (error: any) {
        console.error(`\n[OAuthAudit] ERROR | Callback failure for ${type}:`);
        console.error(`Stack Trace: ${error.stack || error}`);
        console.error(`Prisma Code: ${error.code || 'N/A'}`);
        console.error(`Google API Error: ${JSON.stringify(error.response?.data || error.message || {})}`);
        console.error(`Request Query:`, JSON.stringify(req.query));
        console.error(`Decoded State:`, JSON.stringify(decodedStateObj || rawState));
        console.error(`Mode: ${type}\n`);

        const reason = error.message || 'OAuth callback failed due to an internal error';
        res.redirect(`${frontendUrl}/dashboard?error=auth_failed&reason=${encodeURIComponent(reason)}`);
        return;
      }
    }

    // Fallback: handle as Passport Google User Login
    console.log(`[OAuthAudit] STATE_DECODE | Bypassing Drive OAuth, delegating to Passport Google User Sign-In`);
    passport.authenticate('google', (err: any, user: any) => {
      if (err || !user) {
        console.error(`[OAuthAudit] ERROR | Passport Google Authentication error:`, err || 'No user returned');
        const errMsg = (err?.message || '').toLowerCase();
        const isDbErr = err?.code === 'EAI_AGAIN' || err?.code?.startsWith('P') || errMsg.includes('getaddrinfo') || errMsg.includes('econnrefused');
        if (isDbErr) {
          console.error(`[OAuthAudit] CRITICAL | Database connectivity error during Google OAuth callback: ${err?.message}`);
          return res.redirect(`${frontendUrl}/login?error=service_unavailable&reason=${encodeURIComponent('Database connection temporary issue')}`);
        }
        return res.redirect(`${frontendUrl}/login?error=google_auth_failed`);
      }

      try {
        const payload = { userId: user.id, email: user.email, role: user.role };
        const accessToken = jwt.sign(payload, getJwtSecret(), { expiresIn: '1h' });
        const refreshToken = jwt.sign(payload, getRefreshSecret(), { expiresIn: '7d' });
        const domain = this.getCookieDomain();

        const cookieOptions = {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: (process.env.NODE_ENV === 'production' ? 'none' as const : 'lax' as const),
          ...(domain ? { domain } : {})
        };

        res.cookie('accessToken', accessToken, { ...cookieOptions, maxAge: 60 * 60 * 1000 });
        res.cookie('refreshToken', refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });

        console.log(`[OAuthAudit] FRONTEND_REDIRECT | Passport User Sign-In Success | UserId: ${user.id}`);
        res.redirect(`${frontendUrl}/dashboard`);
      } catch (authErr: any) {
        console.error(`[OAuthAudit] ERROR | Passport cookie sign-in failure:`, authErr);
        res.redirect(`${frontendUrl}/login?error=google_auth_failed`);
      }
    })(req, res, next);
  };

  public getProfile = async (type: AccountType, req: Request, res: Response): Promise<void> => {
    const validTypes: AccountType[] = ['source', 'destination', 'photos-source', 'photos-destination'];
    if (!validTypes.includes(type)) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid account type' });
      return;
    }

    try {
      const userId = (req as any).user.id;
      const profileResponse = await authService.getProfile(userId, type);
      res.json(profileResponse);
    } catch (error) {
      console.error(`Get profile error for ${type}:`, error);
      res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch profile' });
    }
  };

  public logoutAccount = async (type: AccountType, req: Request, res: Response): Promise<void> => {
    const validTypes: AccountType[] = ['source', 'destination', 'photos-source', 'photos-destination'];
    if (!validTypes.includes(type)) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid account type' });
      return;
    }

    try {
      const userId = (req as any).user.id;
      const { tokenStore } = require('./token.store');
      await tokenStore.deleteTokens(userId, type);
      res.json({ success: true, message: `Disconnected ${type} account successfully` });
    } catch (error) {
      console.error(`Logout account error for ${type}:`, error);
      res.status(500).json({ error: 'Internal Server Error', message: 'Failed to disconnect account' });
    }
  };
}

export const authController = new AuthController();
