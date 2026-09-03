import { Router } from 'express';
import { prisma } from '../utils/database';
import { requireUserAuth } from '../auth/auth.middleware';
import { tokenStore } from '../auth/token.store';
import { googleClientManager } from '../auth/google.client';
import { photosMigrationService } from '../services/PhotosMigrationService';
import { photosDiscoveryService } from '../services/PhotosDiscoveryService';
import { PhotosManifestStorage } from '../utils/PhotosManifestStorage';

const router = Router();

const serializeBigInt = (obj: any) => {
  return JSON.parse(
    JSON.stringify(obj, (key, value) =>
      typeof value === 'bigint' ? Number(value) : value
    )
  );
};

function handleRouteError(res: any, error: any, userFriendlyDefault: string) {
  console.error('[PHOTOS_ROUTE_ERROR]', error);
  let userMsg = error?.message || userFriendlyDefault;
  if (typeof userMsg === 'string' && (userMsg.includes('prisma.') || userMsg.includes('invocation:'))) {
    userMsg = userFriendlyDefault;
  }
  return res.status(500).json({ success: false, error: userMsg });
}

// GET /api/photos/migrations/current
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
      res.json(serializeBigInt({
        jobId: job.id,
        status: job.state.toLowerCase(),
        resumeAvailable: job.state === 'PAUSED',
        progress: {
          totalFiles: job.totalFiles,
          completedFiles: job.completedFiles,
          failedFiles: job.failedFiles,
          totalBytes: job.totalBytes,
          transferredBytes: job.transferredBytes,
          photosCount: job.photosCount,
          videosCount: job.videosCount,
          albumsCount: job.albumsCount
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

// POST /api/photos/migrations - Create job
router.post('/migrations', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const sourceAccount = await tokenStore.getAccount(userId, 'photos-source');
    const destAccount = await tokenStore.getAccount(userId, 'photos-destination');

    if (!sourceAccount || !destAccount) {
      return res.status(400).json({
        error: 'Please connect both Source and Destination Google Photos accounts first.'
      });
    }

    const jobId = await photosMigrationService.createPhotosJob(
      userId,
      sourceAccount.email || undefined,
      destAccount.email || undefined
    );

    res.status(201).json({ success: true, jobId, manifestId: jobId });
  } catch (error: any) {
    handleRouteError(res, error, 'Unable to start Google Photos migration. Please check the migration service and try again.');
  }
});

// POST /api/photos/migrations/:id/discovery - Start Discovery
router.post('/migrations/:id/discovery', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const jobId = req.params.id as string;
    const manifestId = jobId;

    photosMigrationService.startDiscovery(jobId, userId, manifestId);
    res.json({ success: true, status: 'DISCOVERING' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/photos/migrations/:id/discovery/status
router.get('/migrations/:id/discovery/status', requireUserAuth, async (req, res) => {
  try {
    const jobId = req.params.id as string;
    const manifestId = jobId;

    const discJob = await prisma.discoveryJob.findUnique({ where: { id: jobId } });
    const stats = await PhotosManifestStorage.getSummaryStats(manifestId);

    res.json(serializeBigInt({
      status: discJob ? discJob.state.toLowerCase() : 'unknown',
      filesFound: discJob?.filesFound || stats.totalItems,
      bytesFound: discJob?.bytesFound || stats.totalBytes,
      photosCount: stats.photosCount,
      videosCount: stats.videosCount,
      albumsCount: stats.albumsCount
    }));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
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
        albumsCount: stats.albumsCount,
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

// GET /api/photos/migrations/:id/report - Generate Summary Report
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
    const albums = await PhotosManifestStorage.getAlbums(manifestId);
    const failedItems = await PhotosManifestStorage.getFailedItems(manifestId);

    const report = {
      title: 'GOOGLE PHOTOS MIGRATION REPORT',
      jobId: job.id,
      sourceEmail: job.session?.sourceEmail || job.sourceEmail,
      destinationEmail: job.session?.destinationEmail || job.destinationEmail,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      status: job.state === 'COMPLETED' ? (stats.failedItems > 0 ? 'PARTIAL' : 'COMPLETED') : job.state,
      summary: {
        totalItems: stats.totalItems,
        photosCount: stats.photosCount,
        videosCount: stats.videosCount,
        albumsDiscovered: stats.albumsCount,
        albumsReconstructed: albums.filter(a => a.status === 'CREATED').length,
        completedItems: stats.completedItems,
        failedItems: stats.failedItems,
        totalBytes: stats.totalBytes,
        transferredBytes: stats.transferredBytes
      },
      limitationsNotices: [
        'Location (GPS) EXIF metadata may be stripped by Google Photos API read calls.',
        'Shared library status and favorite state are restricted by current Google Photos API capabilities.'
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
