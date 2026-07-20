import { Router } from 'express';
import { migrationService } from '../services/MigrationService';
import { getDb, updateJobStatus } from '../utils/database';

const router = Router();

router.post('/start', async (req, res) => {
  console.log('[Backend] MIGRATION START RECEIVED');
  console.log('Payload:', req.body);

  try {
    const job = await migrationService.startMigrationJob(req.body);
    res.status(200).json(job);
  } catch (error: any) {
    console.error('Error starting migration:', error);
    res.status(500).json({ error: error.message || 'Failed to start migration' });
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

      const percentage = job.totalBytes > 0 
        ? Math.floor((job.transferredBytes / job.totalBytes) * 100)
        : (job.totalFiles > 0 ? Math.floor((job.completedFiles / job.totalFiles) * 100) : 0);
        
      const elapsed = Date.now() - job.startedAt;
      const speed = elapsed > 0 ? (job.transferredBytes / (elapsed / 1000)) : 0;
      let remainingSeconds = 0;
      if (speed > 0 && job.totalBytes > 0) {
         remainingSeconds = (job.totalBytes - job.transferredBytes) / speed;
      }

      res.write(`data: ${JSON.stringify({
        status: job.status,
        percentage: Math.min(percentage, 100),
        totalFiles: job.totalFiles,
        completedFiles: job.completedFiles,
        failedFiles: job.failedFiles,
        totalBytes: job.totalBytes,
        transferredBytes: job.transferredBytes,
        totalFolders: job.totalFolders,
        completedFolders: job.completedFolders,
        currentFile: job.currentFile,
        currentFolder: job.currentFolder,
        speedBytesPerSecond: speed,
        remainingSeconds: remainingSeconds,
        logs: logs.map(l => l.message),
        elapsed: elapsed
      })}\n\n`);

      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
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

export default router;
