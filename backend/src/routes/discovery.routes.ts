import { Router, Request, Response } from 'express';
import { prisma } from '../utils/database';
import { requireUserAuth } from '../auth/auth.middleware';
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

const formatAuditLog = (tag: string, details: Record<string, any>) => {
  const ts = new Date().toISOString();
  console.log(`[DiscoveryAudit] ${tag} | timestamp: ${ts} | ${Object.entries(details).map(([k, v]) => `${k}: ${v ?? 'N/A'}`).join(' | ')}`);
};

router.post('/start', requireUserAuth, async (req: Request, res: Response) => {
  const startTime = Date.now();
  const userId = (req as any).user?.id || 'unknown';
  const { itemsParam, sessionId, sourceFolderId, destinationFolderId } = req.body || {};

  formatAuditLog('DISCOVERY_REQUEST_RECEIVED', {
    userId,
    sessionId,
    itemsParam,
    sourceFolderId,
    destinationFolderId
  });

  try {
    if (!itemsParam || !sessionId) {
      formatAuditLog('ERROR', { code: 'INVALID_REQUEST', message: 'Missing itemsParam or sessionId', userId, sessionId });
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Missing itemsParam or sessionId' });
    }

    formatAuditLog('VALIDATE_SESSION', { userId, sessionId });
    const session = await prisma.migrationSession.findUnique({
      where: { id: sessionId, ownerId: userId }
    });

    if (!session) {
      formatAuditLog('ERROR', { code: 'INVALID_SESSION', message: 'Migration session not found', userId, sessionId });
      return res.status(404).json({ code: 'INVALID_SESSION', message: 'Migration session not found' });
    }

    // Validate Accounts
    formatAuditLog('VALIDATE_SOURCE_ACCOUNT', { userId, sessionId, sourceAccountId: session.sourceAccountId });
    formatAuditLog('VALIDATE_DESTINATION_ACCOUNT', { userId, sessionId, destinationAccountId: session.destinationAccountId });
    formatAuditLog('VALIDATE_SOURCE_FOLDER', { userId, sessionId, sourceFolderId: session.sourceFolderId || sourceFolderId });
    formatAuditLog('VALIDATE_DESTINATION_FOLDER', { userId, sessionId, destinationFolderId: session.destinationFolderId || destinationFolderId });

    if (session.discoveryStatus === 'COMPLETED') {
      const active = await prisma.discoveryJob.findFirst({ where: { sessionId } });
      if (active && active.itemsParam === itemsParam) {
        formatAuditLog('JOB_FOUND', { jobId: active.id, sessionId, userId, state: 'COMPLETED' });
        return res.status(200).json(serializeBigInt({
          id: active.id,
          jobId: active.id,
          sessionId,
          status: 'completed',
          message: 'Discovery already completed for this session.'
        }));
      }
    }

    // Check for an active job on this session
    const active = await prisma.discoveryJob.findUnique({
      where: { sessionId }
    });
    
    if (active && ['QUEUED', 'PREPARING', 'SCANNING'].includes(active.state)) {
      const lastHeartbeatMs = active.lastHeartbeat ? active.lastHeartbeat.getTime() : (active.startedAt ? active.startedAt.getTime() : Date.now());
      const heartbeatAgeMs = Date.now() - lastHeartbeatMs;

      // Only mark job as failed if heartbeat is stale for > 5 minutes (300,000ms)
      const TIMEOUT_THRESHOLD = Number(process.env.DISCOVERY_TIMEOUT_MS) || 300000;
      if (heartbeatAgeMs < TIMEOUT_THRESHOLD) {
        formatAuditLog('JOB_FOUND', { jobId: active.id, sessionId, userId, state: active.state, heartbeatAgeMs });
        console.log(`[DISCOVERY] Reconnecting/resuming active job ${active.id} (state: ${active.state}, heartbeatAge: ${heartbeatAgeMs}ms)`);
        return res.status(200).json(serializeBigInt({
          ...active,
          jobId: active.id,
          status: active.state.toLowerCase(),
          message: 'Existing discovery job active. Reconnecting...'
        }));
      } else {
        console.warn(`[DISCOVERY] Stale heartbeat on job ${active.id} (age ${heartbeatAgeMs}ms > ${TIMEOUT_THRESHOLD}ms). Resetting state...`);
      }
    }

    formatAuditLog('UPSERT_DISCOVERY_JOB', { userId, sessionId });
    const manifestId = active?.manifestId || ('manifest_scan_' + Date.now());
    const jobId = active?.id || uuidv4();
    
    console.log(`[DISCOVERY] Upserting DiscoveryJob ${jobId} for session ${sessionId}...`);
    const job = await prisma.discoveryJob.upsert({
      where: { sessionId },
      create: {
        id: jobId,
        ownerId: userId,
        sessionId,
        manifestId,
        itemsParam,
        state: 'QUEUED',
        lastHeartbeat: new Date(),
        startedAt: new Date()
      },
      update: {
        itemsParam,
        manifestId,
        state: 'QUEUED',
        foldersFound: 0,
        filesFound: 0,
        bytesFound: BigInt(0),
        currentFolder: null,
        currentFile: null,
        lastHeartbeat: new Date(),
        startedAt: new Date(),
        completedAt: null,
        cancelledAt: null
      }
    });

    formatAuditLog('JOB_UPSERTED', { jobId: job.id, manifestId, userId, sessionId });

    formatAuditLog('QUEUE_DISCOVERY', { jobId: job.id, sessionId, userId });
    console.log(`[DISCOVERY] Launching background discovery worker for jobId=${job.id}...`);
    discoveryWorker.executeDiscovery(job).catch(err => {
      console.error(`[DISCOVERY] Background discovery execution thrown:`, err.message, err.stack);
      formatAuditLog('ERROR', { code: 'QUEUE_ERROR', message: err.message, stack: err.stack, jobId: job.id, sessionId, userId });
    });

    const elapsed = Date.now() - startTime;
    formatAuditLog('STATUS_RETURNED', { jobId: job.id, sessionId, userId, elapsed });

    return res.status(200).json(serializeBigInt({
      ...job,
      jobId: job.id
    }));
  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    console.error(`[DISCOVERY] Job creation failed:`, error.message, error.stack);
    formatAuditLog('ERROR', {
      code: 'JOB_CREATION_FAILED',
      message: error.message || 'Failed to start discovery',
      stack: error.stack,
      prismaCode: error.code,
      userId,
      sessionId,
      elapsed
    });
    return res.status(500).json({ code: 'JOB_CREATION_FAILED', message: error.message || 'Failed to start discovery' });
  }
});

// REST JSON Status Endpoint
router.get('/:jobId/details', requireUserAuth, async (req: Request, res: Response) => {
  const startTime = Date.now();
  const userId = (req as any).user?.id || 'unknown';
  const jobId = req.params.jobId as string;

  formatAuditLog('STATUS_REQUEST', { jobId, userId });

  try {
    formatAuditLog('JOB_LOOKUP', { jobId, userId });
    let job = await prisma.discoveryJob.findUnique({ where: { id: jobId } });
    if (!job) {
      job = await prisma.discoveryJob.findUnique({ where: { sessionId: jobId } });
    }

    if (!job) {
      formatAuditLog('JOB_NOT_FOUND', { jobId, userId });
      return res.status(404).json({ code: 'JOB_NOT_FOUND', message: 'Discovery job does not exist.' });
    }

    formatAuditLog('JOB_FOUND', { jobId: job.id, sessionId: job.sessionId, userId, state: job.state });
    const elapsed = job.startedAt ? Date.now() - job.startedAt.getTime() : 0;
    const elapsedSec = Math.max(0.1, elapsed / 1000);
    const foldersPerSec = Math.round(((job.foldersFound || 0) / elapsedSec) * 10) / 10;
    const filesPerSec = Math.round(((job.filesFound || 0) / elapsedSec) * 10) / 10;

    return res.status(200).json(serializeBigInt({
      id: job.id,
      jobId: job.id,
      sessionId: job.sessionId,
      status: (job.state || 'QUEUED').toLowerCase(),
      foldersFound: job.foldersFound || 0,
      filesFound: job.filesFound || 0,
      bytesFound: job.bytesFound || BigInt(0),
      foldersPerSec,
      filesPerSec,
      queueDepth: 0,
      activeWorkers: 0,
      currentFolder: job.currentFolder || null,
      currentFile: job.currentFile || null,
      elapsed
    }));
  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    formatAuditLog('ERROR', { code: 'DATABASE_ERROR', message: error.message, stack: error.stack, jobId, userId, elapsed });
    return res.status(500).json({ code: 'DATABASE_ERROR', message: error.message || 'Database lookup error' });
  }
});

// SSE Streaming Status Endpoint
router.get('/:jobId/status', requireUserAuth, async (req: Request, res: Response) => {
  const startTime = Date.now();
  const userId = (req as any).user?.id || 'unknown';
  const jobId = req.params.jobId as string;

  formatAuditLog('STATUS_REQUEST', { jobId, userId, mode: 'SSE' });

  // If request does not explicitly request SSE via header or query param, return standard JSON response
  const acceptsSSE = req.headers.accept?.includes('text/event-stream') || req.query.stream === 'true';

  if (!acceptsSSE) {
    try {
      formatAuditLog('JOB_LOOKUP', { jobId, userId });
      let job = await prisma.discoveryJob.findUnique({ where: { id: jobId } });
      if (!job) {
        job = await prisma.discoveryJob.findUnique({ where: { sessionId: jobId } });
      }

      if (!job) {
        formatAuditLog('JOB_NOT_FOUND', { jobId, userId });
        return res.status(404).json({ code: 'JOB_NOT_FOUND', message: 'Discovery job does not exist.' });
      }

      formatAuditLog('JOB_FOUND', { jobId: job.id, sessionId: job.sessionId, userId, state: job.state });
      const elapsed = job.startedAt ? Date.now() - job.startedAt.getTime() : 0;
      const elapsedSec = Math.max(0.1, elapsed / 1000);
      const foldersPerSec = Math.round(((job.foldersFound || 0) / elapsedSec) * 10) / 10;
      const filesPerSec = Math.round(((job.filesFound || 0) / elapsedSec) * 10) / 10;

      return res.status(200).json(serializeBigInt({
        id: job.id,
        jobId: job.id,
        sessionId: job.sessionId,
        status: (job.state || 'QUEUED').toLowerCase(),
        foldersFound: job.foldersFound || 0,
        filesFound: job.filesFound || 0,
        bytesFound: job.bytesFound || BigInt(0),
        foldersPerSec,
        filesPerSec,
        queueDepth: 0,
        activeWorkers: 0,
        currentFolder: job.currentFolder || null,
        currentFile: job.currentFile || null,
        elapsed
      }));
    } catch (error: any) {
      return res.status(500).json({ code: 'DATABASE_ERROR', message: error.message });
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let heartbeatCount = 0;

  const interval = setInterval(async () => {
    try {
      heartbeatCount++;
      if (heartbeatCount % 10 === 0) {
        res.write(':\n\n');
      }

      let job = await prisma.discoveryJob.findUnique({ where: { id: jobId } });
      if (!job) {
        job = await prisma.discoveryJob.findUnique({ where: { sessionId: jobId } });
      }
      
      if (!job) {
        formatAuditLog('JOB_NOT_FOUND', { jobId, userId });
        res.write(`data: ${JSON.stringify({ code: 'JOB_NOT_FOUND', error: 'Discovery job does not exist.' })}\n\n`);
        clearInterval(interval);
        res.end();
        return;
      }

      const elapsed = job.startedAt ? Date.now() - job.startedAt.getTime() : 0;
      const elapsedSec = Math.max(0.1, elapsed / 1000);
      const foldersPerSec = Math.round(((job.foldersFound || 0) / elapsedSec) * 10) / 10;
      const filesPerSec = Math.round(((job.filesFound || 0) / elapsedSec) * 10) / 10;

      // Watchdog Staleness Detection: Fail job ONLY if lastHeartbeat is older than 5 minutes (300,000ms)
      const lastHeartbeatMs = job.lastHeartbeat ? job.lastHeartbeat.getTime() : (job.startedAt ? job.startedAt.getTime() : Date.now());
      const heartbeatAgeMs = Date.now() - lastHeartbeatMs;
      const TIMEOUT_THRESHOLD = Number(process.env.DISCOVERY_TIMEOUT_MS) || 300000;

      if (['QUEUED', 'PREPARING', 'SCANNING'].includes(job.state) && heartbeatAgeMs > TIMEOUT_THRESHOLD) {
         console.warn(`[DISCOVERY] Job ${job.id} heartbeat stale for ${heartbeatAgeMs}ms (> ${TIMEOUT_THRESHOLD}ms). Failing job.`);
         await prisma.discoveryJob.update({
           where: { id: job.id },
           data: { state: 'FAILED' }
         }).catch(() => {});

         if (job.sessionId) {
           await prisma.migrationSession.update({
             where: { id: job.sessionId },
             data: { discoveryStatus: 'FAILED' }
           }).catch(() => {});
         }

         res.write(`data: ${JSON.stringify({ error: `Discovery job timed out after ${Math.round(TIMEOUT_THRESHOLD / 60000)} minutes of inactivity.` })}\n\n`);
         clearInterval(interval);
         res.end();
         return;
      }

      res.write(`data: ${JSON.stringify(serializeBigInt({
        status: (job.state || 'QUEUED').toLowerCase(),
        foldersFound: job.foldersFound || 0,
        filesFound: job.filesFound || 0,
        bytesFound: job.bytesFound || BigInt(0),
        foldersPerSec,
        filesPerSec,
        currentFolder: job.currentFolder || null,
        currentFile: job.currentFile || null,
        elapsed,
      }))}\n\n`);

      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.state)) {
        if (job.state === 'COMPLETED') {
           const finalSummary = job.manifestId
             ? await prisma.scanSummary.findUnique({ where: { manifestId: job.manifestId } })
             : null;
           res.write(`data: ${JSON.stringify(serializeBigInt({
              event: 'SCAN_COMPLETED',
              data: finalSummary || {
                totalFolders: job.foldersFound || 0,
                totalFiles: job.filesFound || 0,
                totalBytes: job.bytesFound || BigInt(0),
                manifestId: job.manifestId
              }
           }))}\n\n`);
        } else if (job.state === 'FAILED') {
           res.write(`data: ${JSON.stringify({ error: 'Discovery job failed during execution.' })}\n\n`);
        }
        clearInterval(interval);
        res.end();
      }

    } catch (e: any) {
      formatAuditLog('ERROR', { code: 'DATABASE_ERROR', message: e.message, stack: e.stack, jobId, userId });
      res.write(`data: ${JSON.stringify({ code: 'DATABASE_ERROR', error: e.message || 'Database error while fetching job status' })}\n\n`);
      clearInterval(interval);
      res.end();
    }
  }, 1000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

export default router;

