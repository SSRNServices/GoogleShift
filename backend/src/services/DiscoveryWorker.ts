import { prisma } from '../utils/database';
import { DiscoveryService } from './DiscoveryService';
import { AccountType } from '../auth/token.store';
import { DiscoveryJob } from '@prisma/client';

export class DiscoveryWorker {
  public async executeDiscovery(job: DiscoveryJob) {
    console.log(`\n[ENTRY] DiscoveryWorker.executeDiscovery | Job: ${job.id}`);
    
    try {
      await prisma.discoveryJob.update({
        where: { id: job.id },
        data: { state: 'COPYING', startedAt: new Date() } // using COPYING or PREPARING as 'scanning' equivalent since it's a MigrationState enum
      });

      const items = job.itemsParam ? job.itemsParam.split(',').map((part: string) => {
        const [id, itemType] = part.split(':');
        return { id, isFolder: itemType === 'folder' };
      }) : [];

      const onProgress = async (event: string, data: any) => {
        if (event === 'SCAN_FOLDER' || event === 'SCAN_PROGRESS') {
           await prisma.discoveryJob.update({
             where: { id: job.id },
             data: {
               foldersFound: data.totalFolders || 0,
               filesFound: data.totalFiles || 0,
               bytesFound: data.totalBytes ? BigInt(data.totalBytes) : BigInt(0),
               currentFolder: data.folderName || null,
               currentFile: data.currentFile || null
             }
           });
        }
      };

      const summary = await DiscoveryService.executeDiscovery({
        userId: job.ownerId,
        type: 'source' as AccountType, // Assuming source for now
        items,
        manifestId: job.manifestId,
        onProgress
      });

      console.log(`\n[STATE] COMPLETED\nDiscovery: ${job.id}`);
      
      await prisma.discoveryJob.update({
         where: { id: job.id },
         data: {
            state: 'COMPLETED',
            completedAt: new Date(),
            foldersFound: summary.totalFolders,
            filesFound: summary.totalFiles,
            bytesFound: summary.totalBytes ? BigInt(summary.totalBytes) : BigInt(0)
         }
      });
      
    } catch (e: any) {
      console.log(`\n[STATE] FAILED\nDiscovery: ${job.id}\nReason: ${e.message}`);
      await prisma.discoveryJob.update({
         where: { id: job.id },
         data: { state: 'FAILED' }
      });
    }
  }

  public async resumePendingJobs() {
    const pendingJobs = await prisma.discoveryJob.findMany({
      where: {
        state: { in: ['QUEUED', 'COPYING', 'PREPARING'] } // states representing active/scanning
      }
    });
    
    for (const job of pendingJobs) {
      console.log(`[DiscoveryWorker] Resuming pending discovery job: ${job.id}`);
      this.executeDiscovery(job).catch(err => console.error('[FATAL]', err));
    }
  }
}

export const discoveryWorker = new DiscoveryWorker();
