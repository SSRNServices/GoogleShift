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

router.post('/start', requireBothAuth, async (req, res) => {
  console.log('[Backend] MIGRATION START RECEIVED');
  try {
    const userId = (req as any).user.id;
    const active = await prisma.migrationJob.findFirst({
      where: { 
        ownerId: userId,
        state: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] } 
      }
    });
    
    if (active) {
      return res.status(200).json(serializeBigInt({
        jobId: active.id,
        status: active.state.toLowerCase(),
        message: 'Existing migration found and resumed.'
      }));
    }

    const payload: StartMigrationPayload = req.body;
    const job = await migrationService.startMigrationJob(userId, payload);
    res.status(200).json(job);
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
    
    await prisma.migrationJob.update({ where: { id: jobId }, data: { state: 'RUNNING' } });
    const { migrationWorker } = await import('../services/MigrationWorker');
    
    const jobPayload = { ...job, jobId: job.id, sessionId: (req as any).user.id };
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let heartbeatCount = 0;

  const interval = setInterval(async () => {
    try {
      heartbeatCount++;
      // Send a ping every 5 seconds to prevent reverse proxy disconnects
      if (heartbeatCount % 5 === 0) {
        res.write('data: heartbeat\n\n');
      }

      const job = await prisma.migrationJob.findUnique({ where: { id: jobId } });
      
      if (!job) {
        res.write(`data: ${JSON.stringify({ error: 'Job not found' })}\n\n`);
        clearInterval(interval);
        res.end();
        return;
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
        currentAction: job.currentAction
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
  }, 1000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

export default router;
