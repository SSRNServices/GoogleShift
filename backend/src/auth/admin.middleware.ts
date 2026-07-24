import { Request, Response, NextFunction } from 'express';

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const user = req.user as any;
  if (user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Forbidden: Requires SUPER_ADMIN role' });
  }
  
  next();
}
