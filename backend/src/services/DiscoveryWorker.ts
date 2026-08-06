import { prisma } from '../utils/database';
import { DiscoveryService } from './DiscoveryService';
import { AccountType } from '../auth/token.store';
import { DiscoveryJob } from '@prisma/client';

const formatAuditLog = (tag: string, details: Record<string, any>) => {
  const ts = new Date().toISOString();
  console.log(`[DiscoveryAudit] ${tag} | timestamp: ${ts} | ${Object.entries(details).map(([k, v]) => `${k}: ${v ?? 'N/A'}`).join(' | ')}`);
};

export class DiscoveryWorker {
  public async executeDiscovery(job: DiscoveryJob) {
    const startTime = Date.now();
    console.log(`[DISCOVERY] Worker started for jobId=${job.id}, sessionId=${job.sessionId}, userId=${job.ownerId}, manifestId=${job.manifestId}`);
    formatAuditLog('WORKER_STARTED', { jobId: job.id, sessionId: job.sessionId, userId: job.ownerId, manifestId: job.manifestId });
    
    try {
      console.log(`[DISCOVERY] Transitioning jobId=${job.id} state to CONNECTING...`);
      console.log("DISCOVERY STATUS CONNECTING");
      await prisma.discoveryJob.update({
        where: { id: job.id },
        data: { state: 'CONNECTING', startedAt: new Date() }
      });

      if (job.sessionId) {
        await prisma.migrationSession.update({
          where: { id: job.sessionId },
          data: { discoveryStatus: 'RUNNING' }
        }).catch(err => console.warn(`[DISCOVERY] Non-fatal session update error: ${err.message}`));
      }

      formatAuditLog('DISCOVERY_STARTED', { jobId: job.id, sessionId: job.sessionId, userId: job.ownerId });

      const items = job.itemsParam ? job.itemsParam.split(',').map((part: string) => {
        const [id, itemType] = part.split(':');
        return { id, isFolder: itemType === 'folder' };
      }) : [];

      console.log(`[DISCOVERY] Parsed ${items.length} item(s) from itemsParam: ${job.itemsParam}`);

      let lastDbUpdateMs = 0;
      const { RetryHelper } = await import('../utils/retry');

      // Active Heartbeat background interval every 5 seconds
      const heartbeatInterval = setInterval(async () => {
        try {
          await prisma.discoveryJob.update({
            where: { id: job.id },
            data: { lastHeartbeat: new Date() }
          }).catch(() => {});
        } catch (_) {}
      }, 5000);

      const onProgress = async (event: string, data: any) => {
        if (event === 'MANIFEST_UPDATED') {
          console.log("DISCOVERY STATUS FINALIZING");
          await prisma.discoveryJob.update({
            where: { id: job.id },
            data: { state: 'FINALIZING' }
          }).catch(() => {});
          return;
        }

        if (event === 'SCAN_FOLDER' || event === 'SCAN_PROGRESS' || event === 'SCAN_STARTED') {
           const now = Date.now();
           // Throttle DB updates to at most once per 1 second (1000ms) unless it's initial scan start
           if (event !== 'SCAN_STARTED' && (now - lastDbUpdateMs < 1000)) {
             return;
           }
           lastDbUpdateMs = now;

           console.log("DISCOVERY STATUS SCANNING");

           formatAuditLog('DISCOVERY_PROGRESS', {
             jobId: job.id,
             sessionId: job.sessionId,
             userId: job.ownerId,
             foldersFound: data.totalFolders || 0,
             filesFound: data.totalFiles || 0,
             bytesFound: data.totalBytes || 0,
             googleRequests: data.googleRequests || 0,
             elapsed: now - startTime
           });

           try {
             await RetryHelper.withRetry(
               `DiscoveryWorker.updateProgress [jobId=${job.id}]`,
               () => prisma.discoveryJob.update({
                 where: { id: job.id },
                 data: {
                   state: 'SCANNING',
                   foldersFound: data.totalFolders || 0,
                   filesFound: data.totalFiles || 0,
                   bytesFound: data.totalBytes ? BigInt(data.totalBytes) : BigInt(0),
                   currentFolder: data.folderName || data.currentFolder || null,
                   currentFile: data.currentFile || null,
                   lastHeartbeat: new Date()
                 }
               }),
               (msg) => console.log(`[DB] ${msg}`)
             );
           } catch (dbErr: any) {
             console.error(`[DB] Error updating discovery progress in DB for jobId=${job.id}:`, dbErr.message);
           }
        }
      };

      let summary: any = null;
      try {
        console.log(`[DISCOVERY] Executing DiscoveryService for jobId=${job.id}...`);
        summary = await DiscoveryService.executeDiscovery({
          userId: job.ownerId,
          type: 'source' as AccountType,
          items,
          manifestId: job.manifestId,
          onProgress
        });
      } finally {
        clearInterval(heartbeatInterval);
      }

      const totalFolders = summary?.totalFolders || 0;
      const totalFiles = summary?.totalFiles || 0;
      const totalBytes = summary?.totalBytes || 0;

      console.log("DISCOVERY STATUS COMPLETE");
      console.log("DISCOVERY COMPLETE");
      console.log(`[DISCOVERY] Discovery Finished for jobId=${job.id}. Totals -> Folders: ${totalFolders}, Files: ${totalFiles}, Bytes: ${totalBytes}`);
      formatAuditLog('DISCOVERY_COMPLETED', {
        jobId: job.id,
        sessionId: job.sessionId,
        userId: job.ownerId,
        foldersFound: totalFolders,
        filesFound: totalFiles,
        bytesFound: totalBytes,
        elapsed: Date.now() - startTime
      });
      
      await prisma.discoveryJob.update({
         where: { id: job.id },
         data: {
            state: 'COMPLETED',
            completedAt: new Date(),
            foldersFound: totalFolders,
            filesFound: totalFiles,
            bytesFound: totalBytes ? BigInt(totalBytes) : BigInt(0)
         }
      });
      
      if (job.sessionId) {
        console.log(`[DISCOVERY] Updating MigrationSession ${job.sessionId} with discoveryStatus=COMPLETED and manifestId=${job.manifestId}...`);
        await prisma.migrationSession.update({
          where: { id: job.sessionId },
          data: { discoveryStatus: 'COMPLETED', manifestId: job.manifestId }
        }).catch(err => console.error(`[DISCOVERY] Failed to update session discoveryStatus to COMPLETED:`, err.message));
      }
      
    } catch (e: any) {
      console.error(`[DISCOVERY] Fatal error executing discovery for jobId=${job.id}:`, e.message, e.stack);
      formatAuditLog('ERROR', {
        code: 'GOOGLE_API_ERROR',
        message: e.message,
        stack: e.stack,
        jobId: job.id,
        sessionId: job.sessionId,
        userId: job.ownerId,
        elapsed: Date.now() - startTime
      });

      try {
        await prisma.discoveryJob.update({
           where: { id: job.id },
           data: { state: 'FAILED' }
        });
      } catch (dbErr: any) {
        console.error(`[DISCOVERY] Failed to mark discovery job state as FAILED:`, dbErr.message);
      }
      
      if (job.sessionId) {
        try {
          await prisma.migrationSession.update({
            where: { id: job.sessionId },
            data: { discoveryStatus: 'FAILED' }
          });
        } catch (dbErr: any) {
          console.error(`[DISCOVERY] Failed to mark migrationSession discoveryStatus as FAILED:`, dbErr.message);
        }
      }
    }
  }

  public async resumePendingJobs() {
    const pendingJobs = await prisma.discoveryJob.findMany({
      where: {
        state: { in: ['QUEUED', 'CONNECTING', 'DISCOVERING', 'SCANNING', 'FINALIZING'] }
      }
    });
    
    for (const job of pendingJobs) {
      console.log(`[DiscoveryWorker] Resuming pending discovery job: ${job.id}`);
      this.executeDiscovery(job).catch(err => console.error('[FATAL] Resuming discovery job failed:', err));
    }
  }
}

export const discoveryWorker = new DiscoveryWorker();
