import { prisma, logJobEvent } from '../utils/database';
import { PhotosManifestStorage } from '../utils/PhotosManifestStorage';
import { photosDiscoveryService } from './PhotosDiscoveryService';
import { photosMigrationWorker } from './PhotosMigrationWorker';

export class PhotosMigrationService {
  public async createPhotosJob(userId: string, sourceEmail?: string, destinationEmail?: string): Promise<string> {
    const jobId = `photos-migration-${Date.now()}`;
    const manifestId = jobId;

    const session = await prisma.migrationSession.create({
      data: {
        ownerId: userId,
        sourceEmail: sourceEmail || null,
        destinationEmail: destinationEmail || null,
        manifestId,
        serviceType: 'PHOTOS',
        discoveryStatus: 'PENDING',
        migrationStatus: 'PENDING'
      }
    });

    await prisma.migrationJob.create({
      data: {
        id: jobId,
        ownerId: userId,
        sessionId: session.id,
        manifestId,
        serviceType: 'PHOTOS',
        state: 'QUEUED',
        sourceEmail: sourceEmail || null,
        destinationEmail: destinationEmail || null
      }
    });

    console.log(`[PhotosMigrationService] Created Photos Migration Job: ${jobId}`);
    return jobId;
  }

  public async startDiscovery(jobId: string, userId: string, manifestId: string): Promise<void> {
    photosDiscoveryService.discoverPhotos(jobId, userId, manifestId).catch(err => {
      console.error(`[PhotosMigrationService] Discovery failed for ${jobId}:`, err);
      prisma.discoveryJob.update({
        where: { id: jobId },
        data: { state: 'FAILED' }
      }).catch(() => {});
    });
  }

  public async startMigration(jobId: string, userId: string, manifestId: string): Promise<void> {
    const job = await prisma.migrationJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Migration job ${jobId} not found.`);

    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { state: 'COPYING', startedAt: new Date() }
    });

    photosMigrationWorker.executeMigration(jobId, userId, manifestId).catch(err => {
      console.error(`[PhotosMigrationService] Migration execution error for ${jobId}:`, err);
    });
  }

  public async pauseMigration(jobId: string): Promise<void> {
    photosMigrationWorker.pauseJob(jobId);
    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { state: 'PAUSED', currentAction: 'Paused by user' }
    });
    await logJobEvent(jobId, '[STATE] Migration paused by user.');
  }

  public async resumeMigration(jobId: string, userId: string): Promise<void> {
    const job = await prisma.migrationJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Migration job ${jobId} not found.`);

    const manifestId = job.manifestId || jobId;
    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { state: 'COPYING' }
    });

    photosMigrationWorker.executeMigration(jobId, userId, manifestId).catch(err => {
      console.error(`[PhotosMigrationService] Resume execution error for ${jobId}:`, err);
    });
  }

  public async cancelMigration(jobId: string): Promise<void> {
    photosMigrationWorker.cancelJob(jobId);
    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { state: 'CANCELLED', cancelledAt: new Date() }
    });
    await logJobEvent(jobId, '[STATE] Migration cancelled by user.');
  }

  public async retryFailedItems(jobId: string, userId: string, itemIds?: string[]): Promise<number> {
    const job = await prisma.migrationJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Migration job ${jobId} not found.`);

    const manifestId = job.manifestId || jobId;
    const count = await PhotosManifestStorage.resetFailedItems(manifestId, itemIds);

    if (count > 0 && ['COMPLETED', 'PAUSED', 'FAILED'].includes(job.state)) {
      this.resumeMigration(jobId, userId).catch(console.error);
    }

    return count;
  }
}

export const photosMigrationService = new PhotosMigrationService();
