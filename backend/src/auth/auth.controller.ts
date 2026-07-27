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
    // Clear cookies if we were using httpOnly cookies, but we might be using localStorage.
    // So just send success. The frontend will delete tokens.
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

  private issueTokens(user: any, res: Response) {
    const payload = { userId: user.id, email: user.email, role: user.role };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign(payload, REFRESH_SECRET, { expiresIn: '7d' });
    
    // Omit passwordHash before sending
    const { passwordHash, ...userWithoutPassword } = user;
    
    res.json({
      accessToken,
      refreshToken,
      user: userWithoutPassword
    });
  }

  // ==========================================
  // GOOGLE DRIVE OAUTH
  // ==========================================

  public getAuthUrl = (req: Request, res: Response): void => {
    const type = req.params.type as AccountType;
    if (type !== 'source' && type !== 'destination') {
      res.status(400).send('Invalid account type');
      return;
    }
    const url = googleClientManager.getAuthUrl(type);
    res.redirect(url);
  };

  public handleCallback = async (req: Request, res: Response): Promise<void> => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const type = state as AccountType;
    
    if (!code || !state || (type !== 'source' && type !== 'destination')) {
      res.status(400).send('Invalid code or state');
      return;
    }

    try {
      await authService.handleCallback(req.sessionID, type, code);
      
      // Immediately retrieve Profile and Quota to verify token works
      const profileResponse = await authService.getProfile(req.sessionID, type);
      
      console.log(`\n=== OAuth Success for ${type} ===`);
      console.log(`Name: ${profileResponse.profile?.name}`);
      console.log(`Email: ${profileResponse.profile?.email}`);
      console.log(`Storage Used: ${profileResponse.profile?.storage.used}`);
      console.log(`Storage Limit: ${profileResponse.profile?.storage.limit}`);
      console.log('=================================\n');

      // Redirect back to frontend
      const frontendUrl = process.env.NODE_ENV === 'production' 
        ? 'https://migration.ssrnservices.in' 
        : 'http://localhost:5173';
      res.redirect(`${frontendUrl}?connected=${type}`);
    } catch (error: any) {
      console.error(`Error during ${type} callback:`, error);
      if (error.name === 'NetworkError') {
        res.status(502).send("Unable to reach Google's OAuth servers. Please check your internet connection or try again.");
      } else {
        res.status(500).send("Authentication failed");
      }
    }
  };

  public getProfile = async (req: Request, res: Response): Promise<void> => {
    const type = req.params.type as AccountType;
    try {
      const profileResponse = await authService.getProfile(req.sessionID, type);
      res.json(profileResponse);
    } catch (error) {
      console.error(`Unexpected server error fetching profile for ${type}:`, error);
      res.status(500).json({ state: ConnectionState.NOT_CONNECTED, error: 'Internal Server Error' });
    }
  };

  public logout = async (req: Request, res: Response): Promise<void> => {
    const type = req.params.type as AccountType;
    await authService.logout(req.sessionID, type);
    res.json({ success: true });
  };
}

export const authController = new AuthController();
