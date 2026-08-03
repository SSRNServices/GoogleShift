import { Request, Response, NextFunction } from 'express';
import { tokenStore, AccountType } from './token.store';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/database';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_development';

export const requireUserAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.cookies && req.cookies.accessToken) {
      token = req.cookies.accessToken;
    }

    if (!token) {
      console.warn(`[AUTH 401] ${req.method} ${req.originalUrl || req.url} - Missing token. Auth Header: ${!!authHeader}, Cookie: ${!!(req.cookies && req.cookies.accessToken)}`);
      return res.status(401).json({ authenticated: false, error: 'Unauthorized', message: 'Missing token.' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user || user.status === 'PENDING' || !user.isActive) {
      console.warn(`[AUTH 403] ${req.method} ${req.originalUrl || req.url} - User not active or pending. User ID: ${decoded.userId}`);
      return res.status(403).json({ error: 'Forbidden', message: 'User not active or pending approval.' });
    }

    const { passwordHash, ...userWithoutPassword } = user;
    (req as any).user = userWithoutPassword;
    
    next();
  } catch (error: any) {
    console.warn(`[AUTH 401] ${req.method} ${req.originalUrl || req.url} - JWT verification failed: ${error.message}`);
    return res.status(401).json({ authenticated: false, error: 'Unauthorized', message: 'Invalid or expired token.' });
  }
};

export const requireUserAuthBrowser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.cookies && req.cookies.accessToken) {
      token = req.cookies.accessToken;
    }

    if (!token) {
      const frontendUrl = process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? 'https://migration.ssrnservices.in' : 'http://localhost:5173');
      return res.redirect(`${frontendUrl}/login?error=auth_required`);
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user || user.status === 'PENDING' || !user.isActive) {
      const frontendUrl = process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? 'https://migration.ssrnservices.in' : 'http://localhost:5173');
      return res.redirect(`${frontendUrl}/login?error=user_inactive`);
    }

    const { passwordHash, ...userWithoutPassword } = user;
    (req as any).user = userWithoutPassword;
    next();
  } catch (error) {
    const frontendUrl = process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? 'https://migration.ssrnservices.in' : 'http://localhost:5173');
    return res.redirect(`${frontendUrl}/login?error=session_expired`);
  }
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  requireUserAuth(req, res, () => {
    const user: any = (req as any).user;
    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
      return next();
    }
    res.status(403).json({ error: 'Forbidden', message: 'Administrator access required.' });
  });
};

export const requireSuperAdmin = (req: Request, res: Response, next: NextFunction) => {
  requireUserAuth(req, res, () => {
    const user: any = (req as any).user;
    if (user.role === 'SUPER_ADMIN') {
      return next();
    }
    res.status(403).json({ error: 'Forbidden', message: 'Super Administrator access required.' });
  });
};

export const requireAuth = (explicitType?: AccountType) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    requireUserAuth(req, res, async () => {
      try {
        const type = explicitType || (req.params.type as AccountType);
        
        if (type !== 'source' && type !== 'destination') {
          res.status(400).json({ error: 'Bad Request', message: 'Invalid account type' });
          return;
        }

        const userId = (req as any).user.id;
        const tokens = await tokenStore.getTokens(userId, type);
        
        if (!tokens || !tokens.access_token) {
          res.status(401).json({ error: 'Unauthorized', message: `Missing authentication tokens for ${type} account` });
          return;
        }
        
        next();
      } catch (error) {
        console.error(`Auth Middleware Error (${explicitType || 'dynamic'}):`, error);
        res.status(500).json({ error: 'Internal Server Error', message: 'Failed to authenticate request' });
      }
    });
  };
};

export const requireBothAuth = async (req: Request, res: Response, next: NextFunction) => {
  requireUserAuth(req, res, async () => {
    try {
      const userId = (req as any).user.id;
      const sourceTokens = await tokenStore.getTokens(userId, 'source');
      const destTokens = await tokenStore.getTokens(userId, 'destination');
      
      if (!sourceTokens || !sourceTokens.access_token || !destTokens || !destTokens.access_token) {
        res.status(401).json({ error: 'Unauthorized', message: `Missing authentication tokens for source or destination` });
        return;
      }
      
      next();
    } catch (error) {
      console.error(`Auth Middleware Error (Both):`, error);
      res.status(500).json({ error: 'Internal Server Error', message: 'Failed to authenticate request' });
    }
  });
};
