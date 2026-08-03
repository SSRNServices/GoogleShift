import { Router } from 'express';
import { prisma } from '../utils/database';
import { requireBothAuth, requireUserAuth } from '../auth/auth.middleware';
import { discoveryWorker } from '../services/DiscoveryWorker';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

const serializeBigInt = (obj: any) => {
  return JSON.parse(
    JSON.stringify(obj, (key, value) =>
      typeof value === 'bigint' ? Number(value) : value
    )
  );
};

router.post('/start', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { itemsParam, sessionId } = req.body;
    console.log(`[DISCOVERY] Start request received for User: ${userId}, Session: ${sessionId}, Items: ${itemsParam}`);

    if (!itemsParam || !sessionId) {
      return res.status(400).json({ error: 'Missing itemsParam or sessionId' });
    }

    const session = await prisma.migrationSession.findUnique({
      where: { id: sessionId, ownerId: userId }
    });

    if (!session) {
       console.warn(`[DISCOVERY] Migration session ${sessionId} not found for User: ${userId}`);
       return res.status(404).json({ error: 'Migration session not found' });
    }

    if (session.discoveryStatus === 'COMPLETED') {
       const active = await prisma.discoveryJob.findUnique({ where: { sessionId } });
       console.log(`[DISCOVERY] Session ${sessionId} already completed. Job ID: ${active?.id}`);
       return res.status(200).json(serializeBigInt({
         id: active?.id,
         jobId: active?.id,
         status: 'completed',
         message: 'Discovery already completed for this session.'
       }));
    }

    const active = await prisma.discoveryJob.findFirst({
      where: { 
        ownerId: userId,
        sessionId,
        state: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] } 
      }
    });
    
    if (active) {
      console.log(`[DISCOVERY] Active discovery job ${active.id} found for session ${sessionId}. Resuming.`);
      return res.status(200).json(serializeBigInt({
        ...active,
        jobId: active.id,
        status: active.state.toLowerCase(),
        message: 'Existing discovery found and resumed.'
      }));
    }

    const manifestId = 'manifest_scan_' + Date.now();
    const jobId = uuidv4();
    
    const job = await prisma.discoveryJob.create({
      data: {
        id: jobId,
        ownerId: userId,
        sessionId,
        manifestId,
        itemsParam,
        state: 'QUEUED'
      }
    });

    console.log(`[DISCOVERY] Job created: ${jobId} (Manifest: ${manifestId}) for User: ${userId}`);

    discoveryWorker.executeDiscovery(job).catch(err => console.error('[FATAL] DiscoveryWorker error:', err));

    res.status(200).json(serializeBigInt({
      ...job,
      jobId: job.id
    }));
  } catch (error: any) {
    console.error('[DISCOVERY] Error starting discovery:', error);
    res.status(500).json({ error: error.message || 'Failed to start discovery' });
  }
});

router.get('/:jobId/status', requireUserAuth, async (req, res) => {
  const jobId = req.params.jobId as string;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let heartbeatCount = 0;

  const interval = setInterval(async () => {
    try {
      heartbeatCount++;
      if (heartbeatCount % 5 === 0) {
        res.write(':\n\n');
      }

      const job = await prisma.discoveryJob.findUnique({ where: { id: jobId } });
      
      if (!job) {
        res.write(`data: ${JSON.stringify({ error: 'Job not found' })}\n\n`);
        clearInterval(interval);
        res.end();
        return;
      }

      const elapsed = job.startedAt ? Date.now() - job.startedAt.getTime() : 0;
      
      // Calculate estimated remaining and speeds based on elapsed if needed
      // For now we rely on the bytes/folders being sent

      res.write(`data: ${JSON.stringify(serializeBigInt({
        status: job.state.toLowerCase(),
        foldersFound: job.foldersFound,
        filesFound: job.filesFound,
        bytesFound: job.bytesFound,
        currentFolder: job.currentFolder,
        currentFile: job.currentFile,
        elapsed,
      }))}\n\n`);

      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.state)) {
        if (job.state === 'COMPLETED') {
           const finalSummary = await prisma.scanSummary.findUnique({ where: { manifestId: job.manifestId } });
           res.write(`data: ${JSON.stringify(serializeBigInt({
              event: 'SCAN_COMPLETED',
              data: finalSummary
           }))}\n\n`);
        }
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
