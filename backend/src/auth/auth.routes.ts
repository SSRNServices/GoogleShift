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
    session: true
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
  passport.authenticate('google', { failureRedirect: getFrontendUrl() + '/login', session: true }, (err, user) => {
    console.log("=== CALLBACK FORENSICS ===");
    console.log("req.protocol:", req.protocol);
    console.log("req.secure:", req.secure);
    console.log("req.headers['x-forwarded-proto']:", req.headers['x-forwarded-proto']);
    console.log("Passport err:", err);
    console.log("Passport user:", user);
    
    if (err || !user) {
      console.log("Authentication failed! Redirecting to /");
      return res.redirect(getFrontendUrl() + '/');
    }
    
    req.login(user, (loginErr) => {
      console.log("req.login() executed");
      if (loginErr) {
        console.error("req.login() error:", loginErr);
        return res.redirect(getFrontendUrl() + '/');
      }
      
      console.log("req.user exists:", !!req.user);
      console.log("req.session exists:", !!req.session);
      console.log("req.sessionID:", req.sessionID);
      console.log("req.isAuthenticated():", req.isAuthenticated());
      console.log("===========================");
      
      if (req.session && typeof req.session.save === 'function') {
        req.session.save(() => {
          res.redirect(getFrontendUrl() + '/dashboard');
        });
      } else {
        res.redirect(getFrontendUrl() + '/dashboard');
      }
    });
  })(req, res, next);
});

router.get('/me', (req, res) => {
  console.log('[Auth /me] Cookie exists:', !!req.headers.cookie);
  console.log('[Auth /me] Session ID:', req.sessionID);
  console.log('[Auth /me] Is Authenticated:', req.isAuthenticated());
  
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ authenticated: false });
  }
  
  res.status(200).json({ authenticated: true, user: req.user });
});

router.post('/logout', (req, res) => {
  req.logout((err) => {
    if (err) console.error("Logout error:", err);
    if (req.session && typeof req.session.destroy === 'function') {
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ success: true });
      });
    } else {
      res.clearCookie('connect.sid');
      res.json({ success: true });
    }
  });
});

// --- EXISTING DRIVE AUTH ROUTES ---
// Only logged in users can connect Drive accounts

// /google/callback is now handled globally above
router.get('/:type', requireUserAuth, authController.getAuthUrl);
router.get('/:type/profile', requireUserAuth, authController.getProfile);
router.post('/:type/logout', requireUserAuth, authController.logout);

export default router;
