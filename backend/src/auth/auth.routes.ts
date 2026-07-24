import { Router } from 'express';
import passport from 'passport';
import { authController } from './auth.controller';
import { requireUserAuth } from './auth.middleware';

const router = Router();

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_development';

// --- NEW GLOBAL LOGIN ROUTES ---

router.get('/login', (req, res, next) => {
  console.log('\n================================');
  console.log('Passport OAuth Debug');
  console.log('================================');
  console.log(`Client ID: ${process.env.GOOGLE_CLIENT_ID}`);
  console.log(`Callback URL: ${process.env.GOOGLE_LOGIN_REDIRECT_URI}`);
  console.log(`Scopes: openid, profile, email`);
  console.log(`Generated OAuth URL: (Handled internally by Passport)`);
  console.log('================================\n');
  passport.authenticate('google', {
    scope: ['openid', 'profile', 'email'],
    session: false
  })(req, res, next);
});

router.get('/debug/oauth', (req, res) => {
  res.json({
    clientId: process.env.GOOGLE_CLIENT_ID,
    callback: process.env.GOOGLE_LOGIN_REDIRECT_URI,
    generatedAuthUrl: 'Generated at runtime by GoogleStrategy'
  });
});

const getFrontendUrl = () => process.env.NODE_ENV === 'production' 
  ? 'https://migration.ssrnservices.in' 
  : 'http://localhost:5173';

router.get('/google/callback', (req, res, next) => {
  const state = req.query.state as string;
  
  // If state is source or destination, it's a Drive link flow
  if (state === 'source' || state === 'destination') {
    return requireUserAuth(req, res, () => {
      authController.handleCallback(req, res);
    });
  }

  // Otherwise, it's a Passport login flow
  passport.authenticate('google', { failureRedirect: getFrontendUrl(), session: false }, (err, user) => {
    if (err || !user) return res.redirect(getFrontendUrl() + '/');
    
    const userTyped: any = user;
    const token = jwt.sign(
      { id: userTyped.id, email: userTyped.email, role: userTyped.role, status: userTyped.status },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    
    console.log("=== CALLBACK FORENSICS ===");
    console.log("req.user exists:", !!req.user);
    console.log("req.session exists:", !!req.session);
    console.log("req.sessionID:", req.sessionID);
    console.log("req.isAuthenticated():", req.isAuthenticated ? req.isAuthenticated() : false);
    console.log("res.getHeader('Set-Cookie'):", res.getHeader("Set-Cookie"));
    console.log("===========================");
    
    if (req.session && typeof req.session.save === 'function') {
      req.session.save(() => {
        res.redirect(getFrontendUrl() + '/dashboard');
      });
    } else {
      res.redirect(getFrontendUrl() + '/dashboard');
    }
  })(req, res, next);
});

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

// /google/callback is now handled globally above
router.get('/:type', requireUserAuth, authController.getAuthUrl);
router.get('/:type/profile', requireUserAuth, authController.getProfile);
router.post('/:type/logout', requireUserAuth, authController.logout);

export default router;
