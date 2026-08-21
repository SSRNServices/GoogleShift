import { Router, Request, Response } from 'express';
import { prisma } from '../utils/database';
import { requireUserAuth } from '../auth/auth.middleware';
import { discoveryWorker } from '../services/DiscoveryWorker';
import { v4 as uuidv4 } from 'uuid';
import { DiscoveryStatus } from '../types/discoveryStatus';

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

const formatDiscoveryResponse = (job: any, extraMessage?: string) => {
  const rawState = (job.state || job.status || 'QUEUED').toUpperCase();
  const isCompleted = rawState === 'COMPLETED' || job.discoveryStatus === 'COMPLETED';
  const isFailed = rawState === 'FAILED' || job.discoveryStatus === 'FAILED';
  const isCancelled = rawState === 'CANCELLED';

  let statusEnum: string = rawState;
  if (isCompleted) statusEnum = DiscoveryStatus.COMPLETED;
  else if (isFailed) statusEnum = 'FAILED';
  else if (isCancelled) statusEnum = 'CANCELLED';

  const progress = isCompleted ? 100 : (statusEnum === DiscoveryStatus.SCANNING ? 50 : (statusEnum === DiscoveryStatus.FINALIZING ? 90 : 0));

  const foldersCount = job.foldersFound || 0;
  const filesCount = job.filesFound || 0;
  const bytesCount = job.bytesFound || BigInt(0);

  let googleRequests = typeof job.googleRequests === 'number' ? job.googleRequests : 0;
  if (!googleRequests && job.checkpointData) {
    try {
      const parsed = typeof job.checkpointData === 'string' ? JSON.parse(job.checkpointData) : job.checkpointData;
      if (typeof parsed?.googleRequests === 'number') {
        googleRequests = parsed.googleRequests;
      }
    } catch (_) {}
  }

  const calcElapsed = job.elapsed 
    || (job.completedAt && job.startedAt ? new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime() : 0)
    || (job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : 0);

  return serializeBigInt({
    id: job.id || job.jobId,
    jobId: job.id || job.jobId,
    sessionId: job.sessionId,
    manifestId: job.manifestId,
    status: statusEnum,
    phase: statusEnum,
    state: statusEnum,
    progress,
    completed: isCompleted,
    isFinished: isCompleted || isFailed || isCancelled,
    manifestComplete: isCompleted,
    error: isFailed ? (extraMessage || job.error || 'Discovery job failed') : undefined,
    foldersFound: foldersCount,
    filesFound: filesCount,
    bytesFound: bytesCount,
    googleRequests,
    folders: foldersCount,
    files: filesCount,
    bytes: bytesCount,
    totalFolders: foldersCount,
    totalFiles: filesCount,
    totalBytes: bytesCount,
    currentFolder: job.currentFolder || null,
    currentFile: job.currentFile || null,
    elapsed: calcElapsed,
    ...(extraMessage ? { message: extraMessage } : {})
  });
};

const autoHealFinalizingJob = async <T extends { id: string; state: string; manifestId?: string | null; sessionId?: string | null; lastHeartbeat?: Date | null; startedAt?: Date | null }>(job: T): Promise<T> => {
  if (!job || job.state !== 'FINALIZING' || !job.manifestId) return job;
  try {
    const summary = await prisma.scanSummary.findUnique({ where: { manifestId: job.manifestId } });
    if (summary) {
      console.log(`[DISCOVERY AUTO-HEAL] Promoting job ${job.id} from FINALIZING to COMPLETED (scanSummary present).`);
      const updatedJob = await prisma.discoveryJob.update({
        where: { id: job.id },
        data: { state: 'COMPLETED', completedAt: new Date() }
      });
      if (job.sessionId) {
        await prisma.migrationSession.update({
          where: { id: job.sessionId },
          data: { discoveryStatus: 'COMPLETED', manifestId: job.manifestId }
        }).catch(() => {});
      }
      return updatedJob as unknown as T;
    }

    // Fallback Auto-Healing: Check if manifest items exist and heartbeat has elapsed (> 10 seconds)
    const lastHeartbeatMs = job.lastHeartbeat ? new Date(job.lastHeartbeat).getTime() : (job.startedAt ? new Date(job.startedAt).getTime() : 0);
    const heartbeatAgeMs = Date.now() - lastHeartbeatMs;

    if (heartbeatAgeMs > 10000) {
      const { ManifestStorage } = await import('../utils/ManifestStorage');
      const manifestCount = await ManifestStorage.countItems(job.manifestId);
      if (manifestCount > 0) {
        console.log(`[DISCOVERY AUTO-HEAL] Computing manifest aggregates for stale FINALIZING job ${job.id} (${manifestCount} items)...`);
        const stats = await ManifestStorage.getSummaryStats(job.manifestId);
        const folderCount = stats.totalFolders;
        const fileCount = stats.totalFiles;
        const totalBytes = stats.totalBytes;

        await prisma.scanSummary.upsert({
          where: { manifestId: job.manifestId },
          create: {
            manifestId: job.manifestId,
            totalFolders: folderCount,
            totalFiles: fileCount,
            totalBytes,
            destinationStorageLimit: 0,
            destinationStorageUsed: 0,
            estimatedTimeSeconds: Math.ceil(totalBytes / (25 * 1024 * 1024)),
            largestFile: 0
          },
          update: {
            totalFolders: folderCount,
            totalFiles: fileCount,
            totalBytes
          }
        }).catch(() => {});

        console.log(`[DISCOVERY AUTO-HEAL] Successfully auto-healed and promoted job ${job.id} to COMPLETED.`);
        const updatedJob = await prisma.discoveryJob.update({
          where: { id: job.id },
          data: {
            state: 'COMPLETED',
            completedAt: new Date(),
            foldersFound: folderCount,
            filesFound: fileCount,
            bytesFound: BigInt(totalBytes)
          }
        });

        if (job.sessionId) {
          await prisma.migrationSession.update({
            where: { id: job.sessionId },
            data: { discoveryStatus: 'COMPLETED', manifestId: job.manifestId }
          }).catch(() => {});
        }

        return updatedJob as unknown as T;
      }
    }
  } catch (err: any) {
    console.warn('[DISCOVERY AUTO-HEAL] Non-fatal check error:', err.message);
  }
  return job;
};

router.get('/active', requireUserAuth, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id || 'unknown';
  try {
    let activeJob = await prisma.discoveryJob.findFirst({
      where: {
        ownerId: userId,
        state: { in: ['QUEUED', 'CONNECTING', 'DISCOVERING', 'SCANNING', 'FINALIZING'] }
      },
      orderBy: { startedAt: 'desc' }
    });

    if (!activeJob) {
      return res.status(200).json({ active: false, job: null });
    }

    activeJob = await autoHealFinalizingJob(activeJob);

    return res.status(200).json({
      active: true,
      job: formatDiscoveryResponse(activeJob)
    });
  } catch (error: any) {
    console.error(`[DISCOVERY] Failed to check active discovery job for user ${userId}:`, error.message);
    return res.status(500).json({ error: 'Database lookup error' });
  }
});

router.post('/discard', requireUserAuth, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id || 'unknown';
  const { sessionId, jobId } = req.body || {};
  try {
    console.log(`[DISCOVERY] Discard request received for userId=${userId}, sessionId=${sessionId}, jobId=${jobId}`);
    
    if (sessionId) {
      await prisma.discoveryJob.updateMany({
        where: { sessionId, ownerId: userId },
        data: { state: 'CANCELLED', cancelledAt: new Date() }
      }).catch(() => {});

      await prisma.migrationSession.update({
        where: { id: sessionId },
        data: { discoveryStatus: 'CANCELLED', migrationStatus: 'CANCELLED' }
      }).catch(() => {});
    }

    if (jobId) {
      await prisma.discoveryJob.updateMany({
        where: { id: jobId, ownerId: userId },
        data: { state: 'CANCELLED', cancelledAt: new Date() }
      }).catch(() => {});
    }

    await prisma.discoveryJob.updateMany({
      where: { ownerId: userId, state: { in: ['QUEUED', 'CONNECTING', 'DISCOVERING', 'SCANNING', 'FINALIZING'] } },
      data: { state: 'CANCELLED', cancelledAt: new Date() }
    }).catch(() => {});

    return res.status(200).json({ success: true, message: 'Discovery job and migration session discarded successfully.' });
  } catch (err: any) {
    console.error('[DISCOVERY] Failed to discard session:', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Failed to discard session' });
  }
});

router.post('/retry', requireUserAuth, async (req: Request, res: Response) => {
  const startTime = Date.now();
  const userId = (req as any).user?.id || 'unknown';
  const { sessionId, itemsParam } = req.body || {};

  console.log(`[DISCOVERY RETRY] Received retry request for userId=${userId}, sessionId=${sessionId}`);

  try {
    if (!sessionId) {
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Missing sessionId' });
    }

    const session = await prisma.migrationSession.findUnique({
      where: { id: sessionId, ownerId: userId }
    });

    if (!session) {
      return res.status(404).json({ code: 'INVALID_SESSION', message: 'Migration session not found' });
    }

    const effectiveItemsParam = itemsParam || (session.sourceFolderId ? `${session.sourceFolderId}:folder` : 'root:folder');
    const newJobId = uuidv4();
    const newManifestId = `manifest_scan_${Date.now()}`;

    // Background best-effort cleanup of previous job artifacts
    setImmediate(async () => {
      try {
        const existingJobs = await prisma.discoveryJob.findMany({ where: { sessionId } });
        for (const oldJob of existingJobs) {
          console.log(`[DISCOVERY RETRY] Asynchronously purging old job ${oldJob.id} (manifestId: ${oldJob.manifestId})...`);
          if (oldJob.manifestId) {
            const { ManifestStorage } = await import('../utils/ManifestStorage');
            await ManifestStorage.deleteManifest(oldJob.manifestId).catch((err) => console.warn(`[DISCOVERY RETRY] Non-fatal manifest delete warning: ${err.message}`));
            await prisma.scanSummary.deleteMany({ where: { manifestId: oldJob.manifestId } }).catch(() => {});
          }
          await prisma.discoveryJob.delete({ where: { id: oldJob.id } }).catch(() => {});
        }
      } catch (cleanupErr: any) {
        console.warn('[DISCOVERY RETRY] Non-fatal background cleanup warning:', cleanupErr.message);
      }
    });

    console.log(`[DISCOVERY RETRY] Creating fresh DiscoveryJob ${newJobId} with manifestId=${newManifestId}...`);
    const newJob = await prisma.discoveryJob.create({
      data: {
        id: newJobId,
        ownerId: userId,
        sessionId,
        manifestId: newManifestId,
        itemsParam: effectiveItemsParam,
        state: 'QUEUED',
        foldersFound: 0,
        filesFound: 0,
        bytesFound: BigInt(0),
        lastHeartbeat: new Date(),
        startedAt: new Date()
      }
    });

    await prisma.migrationSession.update({
      where: { id: sessionId },
      data: { discoveryStatus: 'RUNNING', manifestId: newManifestId }
    }).catch(() => {});

    console.log(`[DISCOVERY RETRY] Launching background discovery worker for fresh jobId=${newJob.id}...`);
    discoveryWorker.executeDiscovery(newJob).catch(err => {
      console.error(`[DISCOVERY RETRY] Worker launch failed:`, err.message, err.stack);
    });

    formatAuditLog('RETRY_LAUNCHED', { newJobId, sessionId, userId, elapsed: Date.now() - startTime });
    return res.status(200).json(formatDiscoveryResponse(newJob, 'Fresh discovery retry job queued successfully.'));
  } catch (error: any) {
    console.error(`[DISCOVERY RETRY] Retry execution failed:`, error.message, error.stack);
    return res.status(500).json({ code: 'RETRY_FAILED', message: error.message || 'Failed to retry discovery' });
  }
});

router.post('/start', requireUserAuth, async (req: Request, res: Response) => {
  const startTime = Date.now();
  const userId = (req as any).user?.id || 'unknown';
  const { sessionId, sourceFolderId, sourceFolderIds, destinationFolderId } = req.body || {};
  let { itemsParam } = req.body || {};

  formatAuditLog('DISCOVERY_REQUEST_RECEIVED', {
    userId,
    sessionId,
    itemsParam,
    sourceFolderId,
    sourceFolderIds,
    destinationFolderId
  });

  try {
    if (!sessionId) {
      formatAuditLog('ERROR', { code: 'INVALID_REQUEST', message: 'Missing sessionId', userId, sessionId });
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Missing sessionId' });
    }

    formatAuditLog('VALIDATE_SESSION', { userId, sessionId });
    const session = await prisma.migrationSession.findUnique({
      where: { id: sessionId, ownerId: userId }
    });

    if (!session) {
      formatAuditLog('ERROR', { code: 'INVALID_SESSION', message: 'Migration session not found', userId, sessionId });
      return res.status(404).json({ code: 'INVALID_SESSION', message: 'Migration session not found' });
    }

    if (!itemsParam) {
      const ids: string[] = Array.isArray(sourceFolderIds) && sourceFolderIds.length > 0
        ? sourceFolderIds
        : (Array.isArray((session.statistics as any)?.sourceFolderIds) && (session.statistics as any).sourceFolderIds.length > 0
          ? (session.statistics as any).sourceFolderIds
          : (sourceFolderId || session.sourceFolderId ? [sourceFolderId || session.sourceFolderId!] : []));

      if (ids.length > 0) {
        itemsParam = ids.map(id => `${id}:folder`).join(',');
      }
    }

    if (!itemsParam) {
      formatAuditLog('ERROR', { code: 'INVALID_REQUEST', message: 'Missing itemsParam or sourceFolderId', userId, sessionId });
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Missing itemsParam or sourceFolderId' });
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
        return res.status(200).json(formatDiscoveryResponse(
          { ...active, state: 'COMPLETED' },
          'Discovery already completed for this session.'
        ));
      }
    }

    // Check for an active job on this session
    const active = await prisma.discoveryJob.findUnique({
      where: { sessionId }
    });
    
    if (active && ['QUEUED', 'CONNECTING', 'DISCOVERING', 'SCANNING', 'FINALIZING'].includes(active.state)) {
      const lastHeartbeatMs = active.lastHeartbeat ? active.lastHeartbeat.getTime() : (active.startedAt ? active.startedAt.getTime() : Date.now());
      const heartbeatAgeMs = Date.now() - lastHeartbeatMs;

      // Only mark job as failed if heartbeat is stale for > 5 minutes (300,000ms)
      const TIMEOUT_THRESHOLD = Number(process.env.DISCOVERY_TIMEOUT_MS) || 300000;
      if (heartbeatAgeMs < TIMEOUT_THRESHOLD) {
        formatAuditLog('JOB_FOUND', { jobId: active.id, sessionId, userId, state: active.state, heartbeatAgeMs });
        console.log(`[DISCOVERY] Reconnecting/resuming active job ${active.id} (state: ${active.state}, heartbeatAge: ${heartbeatAgeMs}ms)`);
        return res.status(200).json(formatDiscoveryResponse(
          active,
          'Existing discovery job active. Reconnecting...'
        ));
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

    return res.status(200).json(formatDiscoveryResponse(job));
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

    job = await autoHealFinalizingJob(job);

    formatAuditLog('JOB_FOUND', { jobId: job.id, sessionId: job.sessionId, userId, state: job.state });
    return res.status(200).json(formatDiscoveryResponse(job));
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
      return res.status(200).json(formatDiscoveryResponse(job));
    } catch (error: any) {
      return res.status(500).json({ code: 'DATABASE_ERROR', message: error.message });
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof (res as any).flushHeaders === 'function') {
    (res as any).flushHeaders();
  }

  let heartbeatCount = 0;
  let interval: NodeJS.Timeout | null = null;

  const sendDiscoveryTick = async () => {
    try {
      heartbeatCount++;
      // Send SSE ping comment every 10 seconds to prevent proxy dropouts
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
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
        res.end();
        return;
      }

      // Watchdog Staleness Detection: Fail job ONLY if lastHeartbeat is older than 5 minutes (300,000ms)
      const lastHeartbeatMs = job.lastHeartbeat ? job.lastHeartbeat.getTime() : (job.startedAt ? job.startedAt.getTime() : Date.now());
      const heartbeatAgeMs = Date.now() - lastHeartbeatMs;
      const TIMEOUT_THRESHOLD = Number(process.env.DISCOVERY_TIMEOUT_MS) || 300000;

      if (['QUEUED', 'CONNECTING', 'DISCOVERING', 'SCANNING', 'FINALIZING'].includes(job.state) && heartbeatAgeMs > TIMEOUT_THRESHOLD) {
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
         if (interval) {
           clearInterval(interval);
           interval = null;
         }
         res.end();
         return;
      }

      res.write(`data: ${JSON.stringify(formatDiscoveryResponse(job))}\n\n`);

      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.state)) {
        if (job.state === 'COMPLETED') {
           const finalSummary = job.manifestId
             ? await prisma.scanSummary.findUnique({ where: { manifestId: job.manifestId } })
             : null;
           res.write(`data: ${JSON.stringify(serializeBigInt({
              event: 'SCAN_COMPLETED',
              status: DiscoveryStatus.COMPLETED,
              phase: DiscoveryStatus.COMPLETED,
              state: DiscoveryStatus.COMPLETED,
              completed: true,
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
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
        res.end();
      }

    } catch (e: any) {
      formatAuditLog('ERROR', { code: 'DATABASE_ERROR', message: e.message, stack: e.stack, jobId, userId });
      res.write(`data: ${JSON.stringify({ code: 'DATABASE_ERROR', error: e.message || 'Database error while fetching job status' })}\n\n`);
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      res.end();
    }
  };

  // Immediate initial tick
  await sendDiscoveryTick();

  // Recurring tick
  interval = setInterval(sendDiscoveryTick, 1000);

  req.on('close', () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  });
});

export default router;


