import { Router } from 'express';
import { prisma } from '../utils/database';
import { requireUserAuth } from '../auth/auth.middleware';
import { tokenStore } from '../auth/token.store';
import { photosMigrationService } from '../services/PhotosMigrationService';
import { photosPickerService } from '../services/PhotosPickerService';
import { PhotosManifestStorage } from '../utils/PhotosManifestStorage';
import { HttpErrorSanitizer } from '../utils/HttpErrorSanitizer';

import { authService } from '../auth/auth.service';

const router = Router();

const serializeBigInt = (obj: any) => {
  return JSON.parse(
    JSON.stringify(obj, (key, value) =>
      typeof value === 'bigint' ? Number(value) : value
    )
  );
};

function handleRouteError(res: any, error: any, userFriendlyDefault: string) {
  HttpErrorSanitizer.logError('photos.routes', error);
  const info = HttpErrorSanitizer.extractSanitizedInfo(error);
  let userMsg = info.message || userFriendlyDefault;
  if (typeof userMsg === 'string' && (userMsg.includes('prisma.') || userMsg.includes('invocation:'))) {
    userMsg = userFriendlyDefault;
  }
  return res.status(500).json({ success: false, error: userMsg });
}

// GET /api/photos/auth/status - Verify Google Photos Picker scope authorization
router.get('/auth/status', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const authStatus = await authService.isPhotosPickerAuthorized(userId);
    res.json({
      success: true,
      connected: authStatus.pickerAuthorized,
      pickerAuthorized: authStatus.pickerAuthorized,
      email: authStatus.email,
      reason: authStatus.reason || undefined,
      authUrl: '/auth/photos/source'
    });
  } catch (error: any) {
    handleRouteError(res, error, 'Failed to check Google Photos authorization status.');
  }
});

// --- PICKER SESSION ENDPOINTS ---

// POST /api/photos/picker/session - Create a new Google Photos Picker Session
router.post('/picker/session', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const session = await photosPickerService.createPickerSession(userId);
    res.status(201).json({ success: true, session });
  } catch (error: any) {
    handleRouteError(res, error, 'Failed to create Google Photos Picker session.');
  }
});

// GET /api/photos/picker/session/:id - Check status of Google Photos Picker Session
router.get('/picker/session/:id', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const sessionId = req.params.id as string;
    const status = await photosPickerService.getPickerSessionStatus(userId, sessionId);
    res.json({ success: true, status });
  } catch (error: any) {
    handleRouteError(res, error, 'Failed to retrieve Picker session status.');
  }
});

// POST /api/photos/picker/session/:id/items - Enumerate and persist selected items
router.post('/picker/session/:id/items', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const sessionId = req.params.id as string;
    const { manifestId } = req.body || {};

    const targetManifestId = manifestId || `photos-migration-${Date.now()}`;
    const result = await photosPickerService.enumerateAndPersistSelectedItems(userId, sessionId, targetManifestId);

    res.json({
      success: true,
      manifestId: targetManifestId,
      ...result
    });
  } catch (error: any) {
    handleRouteError(res, error, 'Failed to retrieve selected media items from Google Photos.');
  }
});

// --- MIGRATION JOB ENDPOINTS ---

// GET /api/photos/migrations/current - Get active photos migration job
router.get('/migrations/current', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const job = await prisma.migrationJob.findFirst({
      where: {
        ownerId: userId,
        serviceType: 'PHOTOS',
        state: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] }
      },
      orderBy: { startedAt: 'desc' }
    });

    if (job) {
      const manifestId = job.manifestId || job.id;
      const stats = await PhotosManifestStorage.getSummaryStats(manifestId);

      res.json(serializeBigInt({
        jobId: job.id,
        status: job.state.toLowerCase(),
        resumeAvailable: job.state === 'PAUSED',
        destinationFolderId: job.destinationFolderId,
        organization: job.organization || 'FLAT',
        progress: {
          totalFiles: stats.totalItems || job.totalFiles,
          completedFiles: stats.completedItems || job.completedFiles,
          failedFiles: stats.failedItems || job.failedFiles,
          totalBytes: stats.totalBytes || job.totalBytes,
          transferredBytes: stats.transferredBytes || job.transferredBytes,
          photosCount: stats.photosCount || job.photosCount,
          videosCount: stats.videosCount || job.videosCount
        }
      }));
    } else {
      res.json({ status: 'idle' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/photos/migrations/history
router.get('/migrations/history', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const history = await prisma.migrationJob.findMany({
      where: { ownerId: userId, serviceType: 'PHOTOS' },
      include: { session: true },
      orderBy: { startedAt: 'desc' },
      take: 50
    });

    res.json(serializeBigInt({ migrations: history }));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/photos/migrations - Create Google Photos → Google Drive Migration Job
router.post('/migrations', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { pickerSessionId, destinationDriveFolderId, destinationDriveFolderName, organization } = req.body || {};

    const sourceAccount = await tokenStore.getAccount(userId, 'photos-source');
    const destAccount = await tokenStore.getAccount(userId, 'destination');

    if (!sourceAccount) {
      return res.status(400).json({ error: 'Source Google Photos account is not connected.' });
    }

    if (!destAccount) {
      return res.status(400).json({ error: 'Destination Google Drive account is not connected.' });
    }

    if (!pickerSessionId) {
      return res.status(400).json({ error: 'Google Photos Picker session ID is required.' });
    }

    const result = await photosMigrationService.createPhotosJob({
      userId,
      pickerSessionId,
      destinationDriveFolderId: destinationDriveFolderId || 'root',
      destinationDriveFolderName: destinationDriveFolderName || 'My Drive',
      organization: organization === 'BY_YEAR' ? 'BY_YEAR' : 'FLAT',
      sourceEmail: sourceAccount.email || undefined,
      destinationEmail: destAccount.email || undefined
    });

    res.status(201).json({ success: true, ...result });
  } catch (error: any) {
    handleRouteError(res, error, 'Unable to create Google Photos migration job.');
  }
});

// POST /api/photos/migrations/:id/start
router.post('/migrations/:id/start', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const jobId = req.params.id as string;
    const manifestId = jobId;

    await photosMigrationService.startMigration(jobId, userId, manifestId);
    res.json({ success: true, status: 'started' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/photos/migrations/:id/pause
router.post('/migrations/:id/pause', requireUserAuth, async (req, res) => {
  try {
    const jobId = req.params.id as string;
    await photosMigrationService.pauseMigration(jobId);
    res.json({ success: true, status: 'paused' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/photos/migrations/:id/resume
router.post('/migrations/:id/resume', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const jobId = req.params.id as string;
    await photosMigrationService.resumeMigration(jobId, userId);
    res.json({ success: true, status: 'resumed' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/photos/migrations/:id/cancel
router.post('/migrations/:id/cancel', requireUserAuth, async (req, res) => {
  try {
    const jobId = req.params.id as string;
    await photosMigrationService.cancelMigration(jobId);
    res.json({ success: true, status: 'cancelled' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/photos/migrations/:id/retry-failed
router.post('/migrations/:id/retry-failed', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const jobId = req.params.id as string;
    const { itemIds } = req.body || {};

    const count = await photosMigrationService.retryFailedItems(jobId, userId, itemIds);
    res.json({ success: true, retriedCount: count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/photos/migrations/:id
router.get('/migrations/:id', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const jobId = req.params.id as string;

    const job = await prisma.migrationJob.findUnique({
      where: { id: jobId },
      include: { session: true, logs: { orderBy: { createdAt: 'asc' }, take: 100 } }
    });

    if (!job || job.ownerId !== userId) {
      return res.status(404).json({ error: 'Photos migration job not found' });
    }

    const manifestId = job.manifestId || jobId;
    const stats = await PhotosManifestStorage.getSummaryStats(manifestId);
    const failedItems = await PhotosManifestStorage.getFailedItems(manifestId);

    const total = stats.totalItems || job.totalFiles;
    const completed = stats.completedItems || job.completedFiles;
    const percentage = total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : (job.state === 'COMPLETED' ? 100 : 0);
    const computedStatus = job.state === 'COMPLETED' ? (stats.failedItems > 0 ? 'completed_with_errors' : 'completed') : job.state.toLowerCase();

    res.json(serializeBigInt({
      jobId: job.id,
      status: computedStatus,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      sourceEmail: job.session?.sourceEmail || job.sourceEmail,
      destinationEmail: job.session?.destinationEmail || job.destinationEmail,
      destinationFolderId: job.destinationFolderId,
      organization: job.organization || 'FLAT',
      progress: {
        jobId: job.id,
        status: computedStatus,
        percentage,
        totalItems: total,
        completedItems: completed,
        failedItems: stats.failedItems,
        pendingItems: stats.pendingItems,
        photosCount: stats.photosCount,
        videosCount: stats.videosCount,
        totalBytes: stats.totalBytes,
        transferredBytes: stats.transferredBytes,
        currentAction: job.currentAction || 'Processing'
      },
      failedItems: failedItems.map(f => ({
        id: f.id,
        filename: f.sourceFilename,
        mediaType: f.mediaType,
        size: f.size,
        retryCount: f.retryCount,
        error: f.error || 'Transfer error'
      })),
      logs: job.logs.map(l => l.message)
    }));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/photos/migrations/:id/report - Summary Report
router.get('/migrations/:id/report', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const jobId = req.params.id as string;

    const job = await prisma.migrationJob.findUnique({
      where: { id: jobId },
      include: { session: true }
    });

    if (!job || job.ownerId !== userId) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const manifestId = job.manifestId || jobId;
    const stats = await PhotosManifestStorage.getSummaryStats(manifestId);
    const failedItems = await PhotosManifestStorage.getFailedItems(manifestId);

    const report = {
      title: 'GOOGLE PHOTOS TO GOOGLE DRIVE MIGRATION REPORT',
      jobId: job.id,
      sourceEmail: job.session?.sourceEmail || job.sourceEmail,
      destinationEmail: job.session?.destinationEmail || job.destinationEmail,
      destinationFolderId: job.destinationFolderId,
      organization: job.organization || 'FLAT',
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      status: job.state === 'COMPLETED' ? (stats.failedItems > 0 ? 'PARTIAL' : 'COMPLETED') : job.state,
      summary: {
        totalItems: stats.totalItems,
        photosCount: stats.photosCount,
        videosCount: stats.videosCount,
        completedItems: stats.completedItems,
        failedItems: stats.failedItems,
        totalBytes: stats.totalBytes,
        transferredBytes: stats.transferredBytes
      },
      limitationsNotices: [
        'Original filenames and supported metadata (creation date, mime type) preserved.',
        'Files uploaded directly to selected Google Drive destination folder.'
      ],
      failedItemsList: failedItems.map(i => ({
        id: i.id,
        filename: i.sourceFilename,
        mediaType: i.mediaType,
        error: i.error || 'Unknown error'
      }))
    };

    res.json(serializeBigInt(report));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
