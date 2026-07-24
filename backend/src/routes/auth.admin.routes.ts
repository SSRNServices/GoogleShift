import { Router, Request, Response, NextFunction } from 'express';
import passport from 'passport';
import bcrypt from 'bcrypt';
import { prisma } from '../utils/database';
import rateLimit from 'express-rate-limit';

const router = Router();

// Rate limiting for admin login
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 login requests per windowMs
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Setup status
router.get('/setup/status', async (req, res) => {
  try {
    const superAdminExists = await prisma.user.findFirst({
      where: { role: 'SUPER_ADMIN' }
    });
    res.json({ initialized: !!superAdminExists });
  } catch (error) {
    console.error('Failed to check setup status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bootstrap Setup (Creates the first SUPER_ADMIN)
router.post('/setup', async (req, res, next) => {
  try {
    const superAdminExists = await prisma.user.findFirst({
      where: { role: 'SUPER_ADMIN' }
    });

    if (superAdminExists) {
      return res.status(403).json({ error: 'System already initialized. Setup disabled.' });
    }

    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const user = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        isActive: true,
        lastLogin: new Date()
      }
    });

    // Log the user in
    req.login(user, (err) => {
      if (err) return next(err);
      
      // Save session explicitly before returning success
      if (req.session && typeof req.session.save === 'function') {
        req.session.save((saveErr) => {
          if (saveErr) console.error("Session save error during setup:", saveErr);
          res.json({ success: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
        });
      } else {
        res.json({ success: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
      }
    });

  } catch (error) {
    console.error('Setup failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Login
router.post('/login', adminLoginLimiter, (req, res, next) => {
  passport.authenticate('local', (err: any, user: any, info: any) => {
    if (err) return next(err);
    if (!user) {
      return res.status(401).json({ error: info?.message || 'Authentication failed' });
    }
    
    req.login(user, (err) => {
      if (err) return next(err);
      
      if (req.session && typeof req.session.save === 'function') {
        req.session.save((saveErr) => {
          if (saveErr) console.error("Session save error during login:", saveErr);
          res.json({ success: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
        });
      } else {
        res.json({ success: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
      }
    });
  })(req, res, next);
});

export default router;
