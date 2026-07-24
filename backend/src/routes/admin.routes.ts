import { Router } from 'express';
import { requireSuperAdmin } from '../auth/admin.middleware';
import * as adminController from '../controllers/admin.controller';

const router = Router();

// All routes in this router require SUPER_ADMIN
router.use(requireSuperAdmin);

// Dashboard Metrics
router.get('/metrics', adminController.getDashboardMetrics);

export default router;
