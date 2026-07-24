import { Request, Response, NextFunction } from 'express';
import { tokenStore, AccountType } from './token.store';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_development';

export const requireUserAuth = (req: Request, res: Response, next: NextFunction) => {
  const token = req.cookies?.auth_token;
  if (!token) {
    console.log('[Auth] Cookie exists: false');
    return res.status(401).json({ authenticated: false, error: 'Unauthorized', message: 'You must be logged in.' });
  }
  
  console.log('[Auth] Cookie exists: true');
  
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    console.log('[Auth] JWT verified: true');
    console.log('[Auth] User loaded: true');
    
    req.user = payload;
    
    // Disallow pending users
    if (payload.status === 'PENDING') {
      return res.status(403).json({ error: 'Forbidden', message: 'Your account is pending administrator approval.' });
    }
    
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      console.log('[Auth] JWT expired: true');
    } else {
      console.log('[Auth] JWT invalid: true');
    }
    res.status(401).json({ authenticated: false, error: 'Unauthorized', message: 'Invalid or expired session.' });
  }
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  requireUserAuth(req, res, () => {
    const user: any = req.user;
    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
      return next();
    }
    res.status(403).json({ error: 'Forbidden', message: 'Administrator access required.' });
  });
};

export const requireSuperAdmin = (req: Request, res: Response, next: NextFunction) => {
  requireUserAuth(req, res, () => {
    const user: any = req.user;
    if (user.role === 'SUPER_ADMIN') {
      return next();
    }
    res.status(403).json({ error: 'Forbidden', message: 'Super Administrator access required.' });
  });
};

export const requireAuth = (explicitType?: AccountType) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const type = explicitType || (req.params.type as AccountType);
      
      if (type !== 'source' && type !== 'destination') {
        res.status(400).json({ error: 'Bad Request', message: 'Invalid account type' });
        return;
      }

      const tokens = await tokenStore.getTokens(req.sessionID, type);
      
      if (!tokens || !tokens.access_token) {
        res.status(401).json({ error: 'Unauthorized', message: `Missing authentication tokens for ${type} account` });
        return;
      }
      
      next();
    } catch (error) {
      console.error(`Auth Middleware Error (${explicitType || 'dynamic'}):`, error);
      res.status(500).json({ error: 'Internal Server Error', message: 'Failed to authenticate request' });
    }
  };
};

export const requireBothAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sourceTokens = await tokenStore.getTokens(req.sessionID, 'source');
    const destTokens = await tokenStore.getTokens(req.sessionID, 'destination');
    
    if (!sourceTokens || !sourceTokens.access_token || !destTokens || !destTokens.access_token) {
      res.status(401).json({ error: 'Unauthorized', message: `Missing authentication tokens for source or destination` });
      return;
    }
    
    next();
  } catch (error) {
    console.error(`Auth Middleware Error (Both):`, error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to authenticate request' });
  }
};
