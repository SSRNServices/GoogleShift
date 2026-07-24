import { Request, Response, NextFunction } from 'express';

type AllowedRole = 'SUPER_ADMIN' | 'ADMIN' | 'SUPERVISOR';

export function requireRole(allowedRoles: AllowedRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = req.user as any;
    
    if (!user.isActive || user.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Account locked or inactive' });
    }

    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ error: `Forbidden: Requires one of [${allowedRoles.join(', ')}]` });
    }

    next();
  };
}
