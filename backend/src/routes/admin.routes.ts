import { Router } from 'express';
import { requireAdmin } from '../auth/auth.middleware';
import * as adminController from '../controllers/admin.controller';
import * as adminUsersController from '../controllers/admin.users.controller';

const router = Router();

// All routes in this router require at least ADMIN role
router.use(requireAdmin);

// Dashboard Metrics
router.get('/metrics', adminController.getDashboardMetrics);

// Users Management
router.get('/users', adminUsersController.getUsers);
router.post('/users', adminUsersController.createUser);
router.patch('/users/:id', adminUsersController.updateUser);
router.delete('/users/:id', adminUsersController.deleteUser);
router.post('/users/invite', adminUsersController.inviteAdmin); // Left for backwards compatibility

export default router;
