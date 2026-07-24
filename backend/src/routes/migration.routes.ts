import { Router } from 'express';
import { migrationService } from '../services/MigrationService';
import { getDb } from "../utils/database";
import { requireBothAuth } from '../auth/auth.middleware';

const router = Router();

router.get('/current', async (req, res) => {
  try {
    const db = await getDb();
    const job = await db.get(`
      SELECT jobId, status, startedAt 
      FROM migration_jobs 
      WHERE status NOT IN ('completed', 'completed_with_errors', 'failed', 'cancelled')
      ORDER BY startedAt DESC LIMIT 1
    `);
    
    if (job) {
      res.json({
        jobId: job.jobId,
        status: job.status === 'paused' ? 'paused' : 'running',
        resumeAvailable: job.status === 'paused'
      });
    } else {
      res.json({ status: 'idle' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/start', requireBothAuth, async (req, res) => {
  console.log('[Backend] MIGRATION START RECEIVED');
  console.log('Payload:', req.body);

  try {
    const db = await getDb();
    // Validate no running migration
    const active = await db.get(`
      SELECT jobId FROM migration_jobs 
      WHERE status NOT IN ('completed', 'completed_with_errors', 'failed', 'cancelled', 'paused')
    `);
    if (active) {
      return res.status(409).json({ error: 'Migration already running' });
    }

    const job = await migrationService.startMigrationJob(req.sessionID, req.body);
    res.status(200).json(job);
  } catch (error: any) {
    console.error('Error starting migration:', error);
    if (['RequestValidationError', 'ManifestError', 'ShortcutResolutionError'].includes(error.name)) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message || 'Failed to start migration' });
    }
  }
});

router.post('/:jobId/resume', async (req, res) => {
  try {
    const job = await getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'paused') {
      return res.status(400).json({ error: 'Job is not paused' });
    }
    
    await updateJobStatus(req.params.jobId, 'STARTING');
    
    const { migrationWorker } = await import('../services/MigrationWorker');
    
    // Inject the current sessionId into the job so the worker can auth
    job.sessionId = req.sessionID;
    
    migrationWorker.executeMigration(job).catch(err => console.error('[FATAL]', err));

    res.json({ success: true, status: 'starting' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:jobId/cancel', async (req, res) => {
  try {
    await updateJobStatus(req.params.jobId, 'cancelled');
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:jobId/status', async (req, res) => {
  const jobId = req.params.jobId;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let lastUpdated = 0;
  let lastLogId = 0;
  
  const interval = setInterval(async () => {
    try {
      const db = await getDb();
      const job = await db.get(`SELECT * FROM migration_jobs WHERE jobId = ?`, [jobId]);
      
      if (!job) {
        res.write(`data: ${JSON.stringify({ error: 'Job not found' })}\n\n`);
        clearInterval(interval);
        res.end();
        return;
      }

      const logs = await db.all(`SELECT * FROM migration_logs WHERE jobId = ? AND id > ? ORDER BY id ASC`, [jobId, lastLogId]);
      if (logs.length > 0) {
        lastLogId = logs[logs.length - 1].id;
      }

      const transferred = Math.min(job.transferredBytes, job.totalBytes);
      const completed = Math.min(job.completedFiles, job.totalFiles);
      const failed = job.failedFiles;
      
      const percentage = job.totalBytes > 0 
        ? Math.floor((transferred / job.totalBytes) * 100)
        : (job.totalFiles > 0 ? Math.floor(((completed + failed) / job.totalFiles) * 100) : 0);
        
      const elapsed = Date.now() - job.startedAt;
      const speed = elapsed > 0 ? (job.transferredBytes / (elapsed / 1000)) : 0;
      let remainingSeconds = 0;
      if (speed > 0 && job.totalBytes > 0) {
         remainingSeconds = (job.totalBytes - job.transferredBytes) / speed;
      }

      res.write(`data: ${JSON.stringify({
        status: job.status,
        networkStatus: job.networkStatus,
        retryCount: job.retryCount,
        percentage: Math.min(percentage, 100),
        totalFiles: job.totalFiles,
        completedFiles: completed,
        failedFiles: failed,
        totalBytes: job.totalBytes,
        transferredBytes: transferred,
        totalFolders: job.totalFolders,
        completedFolders: job.completedFolders,
        currentFile: job.currentFile,
        currentFolder: job.currentFolder,
        lastSuccessfulFile: job.lastSuccessfulFile,
        speedBytesPerSecond: job.currentSpeed || speed,
        remainingSeconds: job.eta || remainingSeconds,
        activeWorkers: job.busyWorkers,
        pendingQueue: job.queueLength,
        pendingDBWrites: job.pendingDBWrites || 0,
        deadWorkers: job.deadWorkers,
        logs: logs.map(l => l.message),
        elapsed: elapsed
      })}\n\n`);

      if (job.status === 'completed' || job.status === 'completed_with_errors' || job.status === 'failed' || job.status === 'cancelled') {
        clearInterval(interval);
        res.end();
      }

    } catch (e) {
      console.error('SSE Error:', e);
    }
  }, 1000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

router.get('/debug', async (req, res) => {
  try {
    const db = await getDb();
    const job = await db.get(`
      SELECT jobId, status, currentWorkers, idleWorkers, busyWorkers, deadWorkers, 
             queueLength, currentSpeed, averageSpeed, retryCount, transferredBytes, 
             completedFiles, totalFiles, totalBytes, pendingDBWrites
      FROM migration_jobs 
      WHERE status NOT IN ('completed', 'completed_with_errors', 'failed', 'cancelled')
      ORDER BY startedAt DESC LIMIT 1
    `);
    
    if (job) {
      res.json({
        jobId: job.jobId,
        status: job.status,
        workers: job.currentWorkers,
        busy: job.busyWorkers,
        idle: job.idleWorkers,
        dead: job.deadWorkers,
        queue: job.queueLength,
        pendingDBWrites: job.pendingDBWrites || 0,
        retries: job.retryCount,
        speed: job.currentSpeed,
        memory: process.memoryUsage()
      });
    } else {
      res.json({ status: 'idle', memory: process.memoryUsage() });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
