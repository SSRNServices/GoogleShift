import { Router } from 'express';
import passport from 'passport';
import { authController } from './auth.controller';
import { requireUserAuth, requireUserAuthBrowser } from './auth.middleware';

const router = Router();

// --- USER AUTHENTICATION ROUTES (JWT & Passport) ---
router.post('/signup', authController.signup);
router.post('/login', authController.login);
router.post('/logout', authController.logoutUser);
router.post('/refresh', authController.refresh);
router.get('/me', requireUserAuth, authController.getMe);

// Google Passport Login for App Sign-In
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

// Unified Google OAuth Callback (Handles Drive OAuth & User Login OAuth)
router.get('/google/callback', authController.handleGoogleCallback);

// --- DRIVE OAUTH ACCOUNT CONNECTION ROUTES ---
router.get('/source', requireUserAuthBrowser, (req, res) => authController.getAuthUrl('source', req, res));
router.get('/destination', requireUserAuthBrowser, (req, res) => authController.getAuthUrl('destination', req, res));

router.get('/source/profile', requireUserAuth, (req, res) => authController.getProfile('source', req, res));
router.get('/destination/profile', requireUserAuth, (req, res) => authController.getProfile('destination', req, res));

router.post('/source/logout', requireUserAuth, (req, res) => authController.logoutAccount('source', req, res));
router.post('/destination/logout', requireUserAuth, (req, res) => authController.logoutAccount('destination', req, res));

// Fallback for direct browser GET /auth/login -> redirect gracefully to frontend login page
router.get('/login', (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? 'https://migration.ssrnservices.in' : 'http://localhost:5173');
  res.redirect(`${frontendUrl}/login`);
});

export default router;
