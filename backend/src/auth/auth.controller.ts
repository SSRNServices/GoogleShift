import { Request, Response } from 'express';
import { googleClientManager } from './google.client';
import { authService, ConnectionState } from './auth.service';
import { AccountType } from './token.store';
import { prisma } from '../utils/database';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_development';
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'fallback_refresh_secret';

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
      const { refreshToken } = req.body;
      if (!refreshToken) {
        res.status(401).json({ error: 'No refresh token provided' });
        return;
      }
      
      const decoded = jwt.verify(refreshToken, REFRESH_SECRET) as any;
      const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
      
      if (!user || user.status !== 'ACTIVE' || !user.isActive) {
        res.status(401).json({ error: 'Invalid refresh token or inactive account' });
        return;
      }
      
      this.issueTokens(user, res);
    } catch (error) {
      res.status(401).json({ error: 'Invalid refresh token' });
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

  private issueTokens(user: any, res: Response) {
    const payload = { userId: user.id, email: user.email, role: user.role };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign(payload, REFRESH_SECRET, { expiresIn: '7d' });
    
    // Omit passwordHash before sending
    const { passwordHash, ...userWithoutPassword } = user;
    
    const domain = process.env.COOKIE_DOMAIN || (process.env.NODE_ENV === 'production' ? '.migration.ssrnservices.in' : undefined);

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
    if (type !== 'source' && type !== 'destination') {
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

    if (!code) {
      console.error('OAuth Callback Error: Missing authorization code parameter');
      res.redirect(`${frontendUrl}/dashboard?error=auth_failed&reason=${encodeURIComponent('Missing authorization code')}`);
      return;
    }

    // Decode state to determine if this is Drive OAuth or Passport User Sign-In
    let type: AccountType | null = null;
    let stateUserId: string | null = null;

    if (rawState) {
      if (rawState === 'source' || rawState === 'destination') {
        type = rawState;
      } else {
        try {
          const decoded = JSON.parse(Buffer.from(rawState, 'base64url').toString('utf8'));
          if (decoded.type === 'source' || decoded.type === 'destination') {
            type = decoded.type;
            stateUserId = decoded.userId || null;
          }
        } catch {
          // Non-JSON state implies possible Passport Google Sign-In state
        }
      }
    }

    // If it's a Drive OAuth Connection callback
    if (type) {
      try {
        const userId = (req as any).user?.id || stateUserId;
        if (!userId) {
          console.error(`OAuth Callback Error for ${type}: Missing user ID`);
          res.redirect(`${frontendUrl}/login?error=auth_required`);
          return;
        }

        await authService.handleCallback(userId, type, code);
        const profileResponse = await authService.getProfile(userId, type);

        console.log(`\n=== OAuth Success for ${type} ===`);
        console.log(`Account Name: ${profileResponse.profile?.name}`);
        console.log(`Account Email: ${profileResponse.profile?.email}`);
        console.log(`=================================\n`);

        res.redirect(`${frontendUrl}/dashboard?connected=${type}`);
      } catch (error: any) {
        console.error(`Callback error for ${type}:`, error);
        let reason = error.message || 'OAuth callback failed due to an internal server error';
        res.redirect(`${frontendUrl}/dashboard?error=auth_failed&reason=${encodeURIComponent(reason)}`);
      }
      return;
    }

    // Otherwise, handle as Passport Google User Login
    const passport = require('passport');
    passport.authenticate('google', (err: any, user: any) => {
      if (err || !user) {
        console.error('Passport Google Authentication error:', err);
        return res.redirect(`${frontendUrl}/login?error=google_auth_failed`);
      }

      const payload = { userId: user.id, email: user.email, role: user.role };
      const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
      const refreshToken = jwt.sign(payload, REFRESH_SECRET, { expiresIn: '7d' });
      const domain = process.env.COOKIE_DOMAIN || (process.env.NODE_ENV === 'production' ? '.migration.ssrnservices.in' : undefined);

      const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: (process.env.NODE_ENV === 'production' ? 'none' as const : 'lax' as const),
        ...(domain ? { domain } : {})
      };

      res.cookie('accessToken', accessToken, { ...cookieOptions, maxAge: 60 * 60 * 1000 });
      res.cookie('refreshToken', refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });

      res.redirect(`${frontendUrl}/dashboard`);
    })(req, res, next);
  };

  public getProfile = async (type: AccountType, req: Request, res: Response): Promise<void> => {
    if (type !== 'source' && type !== 'destination') {
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
    if (type !== 'source' && type !== 'destination') {
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
