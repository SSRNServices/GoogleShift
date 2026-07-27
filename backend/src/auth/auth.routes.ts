import { Router } from 'express';
import { authController } from './auth.controller';
import { requireUserAuth } from './auth.middleware';

const router = Router();

// --- NEW GLOBAL LOGIN ROUTES ---
router.post('/signup', authController.signup);
router.post('/login', authController.login);
router.post('/logout', authController.logoutUser);
router.post('/refresh', authController.refresh);
router.get('/me', requireUserAuth, authController.getMe);

// --- EXISTING DRIVE AUTH ROUTES ---
// Only logged in users can connect Drive accounts

// The callback handles Drive OAuth logic
router.get('/google/callback', requireUserAuth, authController.handleCallback);
router.get('/:type', requireUserAuth, authController.getAuthUrl);
router.get('/:type/profile', requireUserAuth, authController.getProfile);
router.post('/:type/logout', requireUserAuth, authController.logout);

export default router;
