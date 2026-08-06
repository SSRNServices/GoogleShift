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
    formatAuditLog('WORKER_STARTED', { jobId: job.id, sessionId: job.sessionId, userId: job.ownerId, manifestId: job.manifestId });
    
    try {
      await prisma.discoveryJob.update({
        where: { id: job.id },
        data: { state: 'PREPARING', startedAt: new Date() }
      });

      if (job.sessionId) {
        await prisma.migrationSession.update({
          where: { id: job.sessionId },
          data: { discoveryStatus: 'RUNNING' }
        }).catch(err => console.warn(`[DiscoveryWorker] Non-fatal session update error: ${err.message}`));
      }

      formatAuditLog('DISCOVERY_STARTED', { jobId: job.id, sessionId: job.sessionId, userId: job.ownerId });

      const items = job.itemsParam ? job.itemsParam.split(',').map((part: string) => {
        const [id, itemType] = part.split(':');
        return { id, isFolder: itemType === 'folder' };
      }) : [];

      const onProgress = async (event: string, data: any) => {
        if (event === 'SCAN_FOLDER' || event === 'SCAN_PROGRESS') {
           formatAuditLog('DISCOVERY_PROGRESS', {
             jobId: job.id,
             sessionId: job.sessionId,
             userId: job.ownerId,
             foldersFound: data.totalFolders || 0,
             filesFound: data.totalFiles || 0,
             bytesFound: data.totalBytes || 0,
             elapsed: Date.now() - startTime
           });

           await prisma.discoveryJob.update({
             where: { id: job.id },
             data: {
               foldersFound: data.totalFolders || 0,
               filesFound: data.totalFiles || 0,
               bytesFound: data.totalBytes ? BigInt(data.totalBytes) : BigInt(0),
               currentFolder: data.folderName || null,
               currentFile: data.currentFile || null
             }
           }).catch(() => {});
        }
      };

      const summary = await DiscoveryService.executeDiscovery({
        userId: job.ownerId,
        type: 'source' as AccountType,
        items,
        manifestId: job.manifestId,
        onProgress
      });

      const totalFolders = summary?.totalFolders || 0;
      const totalFiles = summary?.totalFiles || 0;
      const totalBytes = summary?.totalBytes || 0;

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
        await prisma.migrationSession.update({
          where: { id: job.sessionId },
          data: { discoveryStatus: 'COMPLETED', manifestId: job.manifestId }
        }).catch(() => {});
      }
      
    } catch (e: any) {
      formatAuditLog('ERROR', {
        code: 'GOOGLE_API_ERROR',
        message: e.message,
        stack: e.stack,
        jobId: job.id,
        sessionId: job.sessionId,
        userId: job.ownerId,
        elapsed: Date.now() - startTime
      });

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
    }
  }

  public async resumePendingJobs() {
    const pendingJobs = await prisma.discoveryJob.findMany({
      where: {
        state: { in: ['QUEUED', 'COPYING', 'PREPARING'] }
      }
    });
    
    for (const job of pendingJobs) {
      console.log(`[DiscoveryWorker] Resuming pending discovery job: ${job.id}`);
      this.executeDiscovery(job).catch(err => console.error('[FATAL] Resuming discovery job failed:', err));
    }
  }
}

export const discoveryWorker = new DiscoveryWorker();
