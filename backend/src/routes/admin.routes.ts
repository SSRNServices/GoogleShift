import { Router } from 'express';
import { requireSuperAdmin } from '../auth/admin.middleware';
import { requireRole } from '../auth/rbac.middleware';
import * as adminController from '../controllers/admin.controller';
import * as adminUsersController from '../controllers/admin.users.controller';

const router = Router();

// All routes in this router require SUPER_ADMIN
router.use(requireSuperAdmin);

// Dashboard Metrics
router.get('/metrics', adminController.getDashboardMetrics);

// Users Management
router.post('/users/invite', requireRole(['SUPER_ADMIN']), adminUsersController.inviteAdmin);

export default router;
