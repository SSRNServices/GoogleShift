import { Router } from 'express';
import { migrationService } from '../services/MigrationService';
import { prisma } from "../utils/database";
import { requireBothAuth, requireUserAuth } from '../auth/auth.middleware';
import { StartMigrationPayload } from '../transfer/types';

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
       totalBytes: job.totalBytes,
       transferredBytes: job.transferredBytes
    }));

    res.json(serializeBigInt({ migrations: mappedHistory }));
  } catch (error: any) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch migration history' });
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
      manifestCount = await prisma.migrationManifest.count({ where: { jobId: manifestId } });
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
    
    if (active && active.id === payload.manifestId) {
      return res.status(200).json(serializeBigInt({
        jobId: active.id,
        status: active.state.toLowerCase(),
        message: 'Existing migration found and resumed.'
      }));
    } else if (active) {
      return res.status(400).json({ error: 'Another migration is currently active.' });
    }

    // Check manifest entries count
    const manifestCount = await prisma.migrationManifest.count({ where: { jobId: payload.manifestId } });
    if (manifestCount === 0) {
       return res.status(400).json({ error: 'Manifest is empty. No files were found to migrate.' });
    }

    // Create migration job using the session
    const job = await migrationService.startMigrationJob(userId, payload.sessionId, payload);
    
    // Link job to session
    await prisma.migrationJob.update({
      where: { id: (job as any).jobId || (job as any).id },
      data: { sessionId: payload.sessionId }
    });

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
    await prisma.migrationJob.update({ where: { id: jobId }, data: { state: 'CANCELLED', cancelledAt: new Date() } });
    res.json({ success: true });
  } catch (error: any) {
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

  const interval = setInterval(async () => {
    try {
      res.write(':\n\n'); // SSE Heartbeat (every 2s by interval)

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
      
      let percentage = 0;
      if (totalBytes > 0) percentage = Math.floor((transferred / totalBytes) * 100);
      else if (totalFiles > 0) percentage = Math.floor(((completed + failed) / totalFiles) * 100);
      
      const elapsed = job.startedAt ? Date.now() - job.startedAt.getTime() : 0;

      res.write(`id: ${lastCheckedDate.getTime()}\n`);
      res.write(`data: ${JSON.stringify({
        status: job.state.toLowerCase(),
        percentage: Math.min(percentage, 100),
        totalFolders: job.totalFolders,
        totalFiles,
        completedFiles: completed,
        failedFiles: failed,
        totalBytes,
        transferredBytes: transferred,
        speedBytesPerSecond: job.speed,
        remainingSeconds: job.eta,
        elapsed,
        currentAction: job.currentAction,
        currentFile: (job as any).currentFile,
        currentFolder: (job as any).currentFolder,
        logs: logs.map((l: any) => l.message)
      })}\n\n`);

      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.state)) {
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
