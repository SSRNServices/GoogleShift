import { Router } from 'express';
import passport from 'passport';
import { authController } from './auth.controller';
import { requireUserAuth } from './auth.middleware';

const router = Router();

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_development';

// --- NEW GLOBAL LOGIN ROUTES ---

router.get('/login', passport.authenticate('google', {
  scope: ['openid', 'profile', 'email'],
  session: false
}));

const getFrontendUrl = () => process.env.NODE_ENV === 'production' 
  ? 'https://migration.ssrnservices.in' 
  : 'http://localhost:5173';

router.get('/login/callback', 
  passport.authenticate('google', { failureRedirect: getFrontendUrl(), session: false }),
  (req, res) => {
    if (!req.user) return res.redirect(getFrontendUrl() + '/');
    
    const user: any = req.user;
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, status: user.status },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    
    res.redirect(getFrontendUrl() + '/dashboard');
  }
);

router.get('/me', (req, res) => {
  const token = req.cookies?.auth_token;
  if (!token) {
    console.log('[Auth] Cookie exists: false');
    return res.status(401).json({ authenticated: false });
  }
  
  console.log('[Auth] Cookie exists: true');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    console.log('[Auth] JWT verified: true');
    console.log('[Auth] User loaded: true');
    res.status(200).json({ authenticated: true, user: payload });
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      console.log('[Auth] JWT expired: true');
    } else {
      console.log('[Auth] JWT invalid: true');
    }
    res.status(401).json({ authenticated: false });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});

// --- EXISTING DRIVE AUTH ROUTES ---
// Only logged in users can connect Drive accounts

router.get('/google/callback', requireUserAuth, authController.handleCallback);
router.get('/:type', requireUserAuth, authController.getAuthUrl);
router.get('/:type/profile', requireUserAuth, authController.getProfile);
router.post('/:type/logout', requireUserAuth, authController.logout);

export default router;
