import { Router } from 'express';
import { migrationService } from '../services/MigrationService';
import { prisma } from "../utils/database";
import { requireBothAuth, requireUserAuth } from '../auth/auth.middleware';
import { StartMigrationPayload } from '../transfer/types';
import { jobRegistry } from '../transfer/JobRegistry';

const router = Router();

const serializeBigInt = (obj: any) => {
  return JSON.parse(
    JSON.stringify(obj, (key, value) =>
      typeof value === 'bigint' ? Number(value) : value
    )
  );
};

router.get('/current', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const job = await prisma.migrationJob.findFirst({
      where: {
        ownerId: userId,
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
          speed: job.speed,
          eta: job.eta
        }
      }));
    } else {
      res.json({ status: 'idle' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/history', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const history = await prisma.migrationJob.findMany({
      where: { ownerId: userId },
      include: {
        session: true
      },
      orderBy: { startedAt: 'desc' },
      take: 50
    });

    const mappedHistory = history.map(job => ({
       jobId: job.id,
       status: job.state.toLowerCase(),
       createdAt: job.startedAt,
       endedAt: job.completedAt,
       completedFiles: job.completedFiles,
       totalFiles: job.totalFiles,
       failedFiles: job.failedFiles,
       totalFolders: job.totalFolders,
       completedFolders: (job as any).completedFolders || 0,
       totalBytes: job.totalBytes,
       transferredBytes: job.transferredBytes,
       speed: job.speed,
       eta: job.eta,
       currentAction: job.currentAction,
       currentFile: (job as any).currentFile,
       currentFolder: (job as any).currentFolder,
       sourceSelection: job.session ? [{ name: job.session.sourceFolderId }] : [],
       destinationFolder: job.session ? { name: job.session.destinationFolderId } : undefined
    }));

    res.json(serializeBigInt({ migrations: mappedHistory }));
  } catch (error: any) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch migration history' });
  }
});

async function getDetailedFailedItems(jobId: string, manifestId?: string) {
  try {
    const targetId = manifestId || jobId;
    const { ManifestStorage } = await import('../utils/ManifestStorage');
    const failedManifestItems = await ManifestStorage.getFailedItems(targetId);

    const failedItems = await prisma.migrationItem.findMany({
      where: { jobId, status: 'FAILED' }
    });
    const errMap = new Map<string, string>();
    for (const item of failedItems) {
      if (item.error) errMap.set(item.fileId, item.error);
    }

    return failedManifestItems.map((item: any) => {
      const rawError = errMap.get(item.id) || 'Transfer retries exhausted';
      let errorMsg = rawError;
      let classification = 'Stream Lifecycle Error';

      if (rawError.includes('Classification:')) {
        const parts = rawError.split('Classification:');
        errorMsg = parts[0].trim().replace(/\|$/, '').trim();
        classification = parts[1].trim();
      } else if (rawError.toLowerCase().includes('timeout')) {
        classification = 'Timeout Error';
      } else if (rawError.toLowerCase().includes('stall')) {
        classification = 'Network Stall Error';
      } else if (rawError.toLowerCase().includes('rate')) {
        classification = 'Rate Limit Error';
      } else if (rawError.toLowerCase().includes('google api')) {
        classification = 'Google API Error';
      }

      return {
        id: item.id,
        name: item.name || 'Unknown File',
        mimeType: item.mimeType || 'application/octet-stream',
        size: Number(item.size || 0),
        retryCount: item.retryCount || 5,
        error: errorMsg,
        classification,
        retryExhausted: true
      };
    });
  } catch (e) {
    return [];
  }
}

// Fetch full migration details by jobId
router.get('/:jobId', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const jobId = req.params.jobId as string;

    const job = await prisma.migrationJob.findUnique({
      where: { id: jobId },
      include: {
        session: true,
        logs: {
          orderBy: { createdAt: 'asc' },
          take: 100
        }
      }
    });

    if (!job || job.ownerId !== userId) {
      return res.status(404).json({ error: 'Migration job not found' });
    }

    const logs = job.logs.map(l => l.message);
    const isTerminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.state);
    let computedStatus = job.state.toLowerCase();
    if (job.state === 'COMPLETED') {
      computedStatus = job.failedFiles > 0 ? 'completed_with_errors' : 'completed';
    }

    const processed = job.completedFiles + job.failedFiles;
    let filePercentage = job.totalFiles > 0 ? Math.min(100, Math.floor((processed / job.totalFiles) * 100)) : 0;
    let bytePercentage = job.totalBytes > BigInt(0) ? Math.min(100, Math.floor((Number(job.transferredBytes) / Number(job.totalBytes)) * 100)) : 0;

    if (isTerminal) {
      filePercentage = 100;
      bytePercentage = 100;
    }
    const percentage = isTerminal ? 100 : (job.totalBytes > BigInt(0) ? bytePercentage : filePercentage);

    const failedItems = await getDetailedFailedItems(jobId, job.manifestId || undefined);

    res.json(serializeBigInt({
      jobId: job.id,
      status: computedStatus,
      sessionId: job.sessionId,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      sourceEmail: job.session?.sourceEmail,
      destinationEmail: job.session?.destinationEmail,
      failedItems,
      progress: {
        status: computedStatus,
        percentage,
        bytePercentage,
        filePercentage,
        totalFiles: job.totalFiles,
        completedFiles: job.completedFiles,
        failedFiles: job.failedFiles,
        totalFolders: job.totalFolders,
        completedFolders: (job as any).completedFolders || 0,
        totalBytes: job.totalBytes,
        transferredBytes: job.transferredBytes,
        speedBytesPerSecond: job.speed,
        remainingSeconds: isTerminal ? null : job.eta,
        currentAction: isTerminal ? (computedStatus === 'completed_with_errors' ? 'Completed with Errors' : 'Completed') : job.currentAction,
        currentFile: isTerminal ? 'Completed' : ((job as any).currentFile || ''),
        currentFolder: isTerminal ? 'Completed' : ((job as any).currentFolder || '')
      },
      logs,
      errors: logs.filter(l => l.includes('FAILED') || l.includes('Error'))
    }));
  } catch (error: any) {
    console.error('Error fetching migration details:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch migration details' });
  }
});

// Fetch current live runtime state by jobId (polling fallback)
router.get('/:jobId/live', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const jobId = req.params.jobId as string;

    const job = await prisma.migrationJob.findUnique({
      where: { id: jobId },
      include: {
        logs: {
          orderBy: { createdAt: 'desc' },
          take: 20
        }
      }
    });

    if (!job || job.ownerId !== userId) {
      return res.status(404).json({ error: 'Migration job not found' });
    }

    const transferred = Number(job.transferredBytes);
    const totalBytes = Number(job.totalBytes);
    const completed = job.completedFiles;
    const totalFiles = job.totalFiles;
    const failed = job.failedFiles;
    const processed = completed + failed;

    const isTerminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.state);
    let computedStatus = job.state.toLowerCase();
    if (job.state === 'COMPLETED') {
      computedStatus = failed > 0 ? 'completed_with_errors' : 'completed';
    }

    let percentage = 0;
    if (isTerminal) {
      percentage = 100;
    } else if (totalBytes > 0) {
      percentage = Math.floor((transferred / totalBytes) * 100);
    } else if (totalFiles > 0) {
      percentage = Math.floor((processed / totalFiles) * 100);
    }

    const elapsed = job.startedAt ? Date.now() - job.startedAt.getTime() : 0;
    const failedItems = await getDetailedFailedItems(jobId, job.manifestId || undefined);

    res.json(serializeBigInt({
      status: computedStatus,
      percentage: Math.min(percentage, 100),
      totalFolders: job.totalFolders,
      completedFolders: (job as any).completedFolders || 0,
      totalFiles,
      completedFiles: completed,
      failedFiles: failed,
      totalBytes,
      transferredBytes: transferred,
      speedBytesPerSecond: job.speed,
      remainingSeconds: isTerminal ? null : job.eta,
      elapsed,
      currentAction: isTerminal ? (computedStatus === 'completed_with_errors' ? 'Completed with Errors' : 'Completed') : job.currentAction,
      currentFile: isTerminal ? 'Completed' : ((job as any).currentFile || ''),
      currentFolder: isTerminal ? 'Completed' : ((job as any).currentFolder || ''),
      failedItems,
      logs: job.logs.map(l => l.message).reverse()
    }));
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch live migration state' });
  }
});

// Validation API
router.get('/validate/:sessionId', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const sessionId = req.params.sessionId as string;

    const session = await prisma.migrationSession.findUnique({
      where: { id: sessionId, ownerId: userId }
    });

    if (!session) {
      return res.status(404).json({
        ready: false,
        error: 'Migration session not found',
        sourceAuthenticated: false,
        destinationAuthenticated: false,
        sourceRefreshValid: false,
        destinationRefreshValid: false,
        manifestExists: false,
        discoveryCompleted: false,
        destinationWritable: false
      });
    }

    const { tokenStore } = await import('../auth/token.store');
    const { googleClientManager } = await import('../auth/google.client');

    const [sourceAccount, destAccount] = await Promise.all([
      tokenStore.getAccount(userId, 'source'),
      tokenStore.getAccount(userId, 'destination')
    ]);

    const sourceAuthenticated = !!sourceAccount && !!sourceAccount.accessToken;
    const destinationAuthenticated = !!destAccount && !!destAccount.accessToken;
    const sourceRefreshValid = !!sourceAccount && !!sourceAccount.refreshToken;
    const destinationRefreshValid = !!destAccount && !!destAccount.refreshToken;

    const manifestId = session.manifestId;
    let manifestExists = false;
    let manifestCount = 0;
    if (manifestId) {
      const { ManifestStorage } = await import('../utils/ManifestStorage');
      manifestCount = await ManifestStorage.countItems(manifestId);
      manifestExists = manifestCount > 0;
    }

    const discoveryCompleted = session.discoveryStatus === 'COMPLETED';

    // Verify destination folder writable/accessible
    let destinationWritable = false;
    if (destinationAuthenticated && session.destinationFolderId) {
      try {
        const destClient = await googleClientManager.getAuthenticatedClient(userId, 'destination');
        if (destClient) {
          destinationWritable = true;
        }
      } catch (e) {
        destinationWritable = false;
      }
    }

    const errors: string[] = [];
    if (!sourceAuthenticated || !sourceRefreshValid) errors.push('Source authentication missing or expired. Reconnect source account.');
    if (!destinationAuthenticated || !destinationRefreshValid) errors.push('Destination authentication missing or expired. Reconnect destination account.');
    if (!manifestExists) errors.push('Migration manifest is empty or missing.');
    if (!discoveryCompleted) errors.push('Discovery phase has not completed.');
    if (!destinationWritable) errors.push('Destination folder is inaccessible or not writable.');

    const ready = sourceAuthenticated && destinationAuthenticated && sourceRefreshValid && destinationRefreshValid && manifestExists && discoveryCompleted && destinationWritable;

    res.json({
      ready,
      sourceAuthenticated,
      destinationAuthenticated,
      sourceRefreshValid,
      destinationRefreshValid,
      manifestExists,
      discoveryCompleted,
      destinationWritable,
      errors
    });
  } catch (error: any) {
    console.error('Error validating migration session:', error);
    res.status(500).json({ ready: false, error: error.message });
  }
});

router.post('/start', requireBothAuth, async (req, res) => {
  console.log('[Backend] MIGRATION START RECEIVED');
  try {
    const userId = (req as any).user.id;
    const payload: StartMigrationPayload & { sessionId?: string } = req.body;
    
    console.log(`[Migration Routes] Starting migration for Session ID: ${payload.sessionId}`);

    // Require sessionId and manifestId strictly
    if (!payload.sessionId || !payload.manifestId) {
      console.warn(`[Migration Routes] Missing sessionId or manifestId in payload:`, payload);
      res.status(400).json({ error: 'Missing required payload: sessionId and manifestId are required' });
      return;
    }

    const session = await prisma.migrationSession.findUnique({
      where: { id: payload.sessionId, ownerId: userId }
    });

    if (!session) {
      console.warn(`[Migration Routes] Session not found: ${payload.sessionId}`);
      res.status(404).json({ error: 'Migration session not found' });
      return;
    }

    if (session.discoveryStatus !== 'COMPLETED') {
      console.warn(`[Migration Routes] Invalid discovery status for session ${payload.sessionId}: ${session.discoveryStatus}`);
      res.status(400).json({ error: `Cannot start migration. Discovery status is ${session.discoveryStatus} (expected COMPLETED).` });
      return;
    }

    if (session.manifestId !== payload.manifestId) {
      console.warn(`[Migration Routes] Manifest ID mismatch for session ${payload.sessionId}. Expected: ${session.manifestId}, Got: ${payload.manifestId}`);
      res.status(400).json({ error: 'Manifest ID does not match the active session.' });
      return;
    }

    // PRE-MIGRATION BACKEND SAFEGUARDS & TOKEN REFRESH
    const { googleClientManager } = await import('../auth/google.client');
    const sourceClient = await googleClientManager.getAuthenticatedClient(userId, 'source');
    if (!sourceClient) {
      return res.status(401).json({ error: 'Source account authentication missing or expired. Please reconnect source account.' });
    }

    const destClient = await googleClientManager.getAuthenticatedClient(userId, 'destination');
    if (!destClient) {
      return res.status(401).json({ error: 'Account destination not authenticated. Please reconnect destination account.' });
    }

    const active = await prisma.migrationJob.findFirst({
      where: { 
        ownerId: userId,
        state: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] } 
      }
    });
    
    if (active) {
      return res.status(409).json(serializeBigInt({
        error: 'Another migration is currently active.',
        jobId: active.id,
        status: active.state.toLowerCase(),
        message: 'Active migration in progress.'
      }));
    }

    // Check manifest entries count
    const { ManifestStorage } = await import('../utils/ManifestStorage');
    const manifestCount = await ManifestStorage.countItems(payload.manifestId);
    if (manifestCount === 0) {
       return res.status(400).json({ error: 'Manifest is empty. No files were found to migrate.' });
    }

    // Create a new unique migration job
    const job = await migrationService.startMigrationJob(userId, payload.sessionId, payload);
    
    await prisma.migrationSession.update({
      where: { id: payload.sessionId },
      data: { migrationStatus: 'RUNNING' }
    });

    res.status(200).json({ success: true, job });
  } catch (error: any) {
    console.error('Error starting migration:', error);
    if (['RequestValidationError', 'ManifestError', 'ShortcutResolutionError'].includes(error.name)) {
      res.status(400).json({ error: error.message, reason: error.message });
    } else {
      res.status(500).json({ error: error.message || 'Failed to start migration' });
    }
  }
});

router.post('/:jobId/resume', requireUserAuth, async (req, res) => {
  try {
    const jobId = req.params.jobId as string;
    const job = await prisma.migrationJob.findUnique({ where: { id: jobId } });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.state !== 'PAUSED') return res.status(400).json({ error: 'Job is not paused' });
    
    await prisma.migrationJob.update({ where: { id: jobId }, data: { state: 'COPYING' } });
    const { migrationWorker } = await import('../services/MigrationWorker');
    
    const jobPayload = { ...job, jobId: job.id, sessionId: job.sessionId || (req as any).user.id };
    migrationWorker.executeMigration(jobPayload as any).catch(err => console.error('[FATAL]', err));

    res.json({ success: true, status: 'starting' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:jobId/cancel', requireUserAuth, async (req, res) => {
  try {
    const jobId = req.params.jobId as string;

    // 1. Update DB state first (so the scheduler sees it if it polls)
    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { state: 'CANCELLED', cancelledAt: new Date() }
    });

    // 2. Signal the active scheduler (if any) to abort all workers and destroy streams.
    //    This is the key fix: previously cancel only updated the DB and left workers running.
    await jobRegistry.cancelJob(jobId);

    console.log(`[migration.routes] CANCEL_COMPLETE | JobId: ${jobId}`);
    res.json({ success: true });
  } catch (error: any) {
    console.error(`[migration.routes] CANCEL_ERROR | ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:jobId/status', async (req, res) => {
  const jobId = req.params.jobId as string;
  const lastEventId = req.headers['last-event-id'] || '0';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let lastCheckedDate = lastEventId !== '0' ? new Date(parseInt(lastEventId as string)) : new Date(0);

  // Stall detection state for this SSE connection
  let prevTransferred = -1;
  let prevCompleted = -1;
  let stallTickCount = 0;
  const STALL_TICK_THRESHOLD = 3; // 3 ticks × 2s = 6 seconds without change → stalled

  const interval = setInterval(async () => {
    try {
      res.write(':\n\n'); // SSE comment heartbeat

      const job = await prisma.migrationJob.findUnique({ where: { id: jobId } });

      if (!job) {
        res.write(`data: ${JSON.stringify({ error: 'Job not found' })}\n\n`);
        clearInterval(interval);
        res.end();
        return;
      }

      const logs = await prisma.migrationLog.findMany({
        where: { jobId, createdAt: { gt: lastCheckedDate } },
        orderBy: { createdAt: 'asc' }
      });
      if (logs.length > 0) {
        lastCheckedDate = logs[logs.length - 1].createdAt;
      }

      const transferred = Number(job.transferredBytes);
      const totalBytes = Number(job.totalBytes);
      const completed = job.completedFiles;
      const totalFiles = job.totalFiles;
      const failed = job.failedFiles;
      const processed = completed + failed;

      const isTerminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.state);
      let computedStatus = job.state.toLowerCase();
      if (job.state === 'COMPLETED') {
        computedStatus = failed > 0 ? 'completed_with_errors' : 'completed';
      }

      let bytePercentage = totalBytes > 0 ? Math.min(100, Math.floor((transferred / totalBytes) * 100)) : 0;
      let filePercentage = totalFiles > 0 ? Math.min(100, Math.floor((processed / totalFiles) * 100)) : 0;

      if (isTerminal) {
        bytePercentage = 100;
        filePercentage = 100;
      }
      const percentage = isTerminal ? 100 : (totalBytes > 0 ? bytePercentage : filePercentage);

      // ── Stall detection ───────────────────────────────────────────────────────
      const isActive = ['COPYING', 'PREPARING'].includes(job.state);
      let stalled = false;
      let recovering = false;

      if (isActive) {
        if (transferred === prevTransferred && completed === prevCompleted) {
          stallTickCount++;
        } else {
          stallTickCount = 0;
          prevTransferred = transferred;
          prevCompleted = completed;
        }
        stalled = stallTickCount >= STALL_TICK_THRESHOLD;
        const handle = jobRegistry.get(jobId);
        recovering = stalled && !!handle;
      }

      const speed = job.speed || 0;
      const remainingSeconds = (isTerminal || !isActive) ? null : ((job.eta && job.eta > 0 && speed > 0) ? job.eta : null);
      const elapsed = job.startedAt ? Date.now() - job.startedAt.getTime() : 0;
      const failedItems = await getDetailedFailedItems(jobId, job.manifestId || undefined);

      res.write(`id: ${lastCheckedDate.getTime()}\n`);
      res.write(`data: ${JSON.stringify({
        status: computedStatus,
        percentage: Math.min(percentage, 100),
        bytePercentage,
        filePercentage,
        totalFolders: job.totalFolders,
        totalFiles,
        completedFiles: completed,
        failedFiles: failed,
        totalBytes,
        transferredBytes: transferred,
        speedBytesPerSecond: speed,
        remainingSeconds,
        stalled,
        recovering,
        elapsed,
        currentAction: isTerminal ? (computedStatus === 'completed_with_errors' ? 'Completed with Errors' : 'Completed') : job.currentAction,
        currentFile: isTerminal ? 'Completed' : ((job as any).currentFile || ''),
        currentFolder: isTerminal ? 'Completed' : ((job as any).currentFolder || ''),
        failedItems,
        logs: logs.map((l: any) => l.message)
      })}\n\n`);

      if (isTerminal) {
        clearInterval(interval);
        res.end();
      }
    } catch (e: any) {
      console.error('SSE Error:', e);
      res.write(`data: ${JSON.stringify({ error: 'Internal server error while fetching job status' })}\n\n`);
      clearInterval(interval);
      res.end();
    }
  }, 2000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

export default router;
