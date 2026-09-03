import { prisma, logJobEvent } from '../utils/database';
import { PhotosManifestStorage } from '../utils/PhotosManifestStorage';
import { photosPickerService } from './PhotosPickerService';
import { photosMigrationWorker } from './PhotosMigrationWorker';

export interface CreatePhotosJobParams {
  userId: string;
  pickerSessionId?: string;
  manifestId?: string;
  destinationDriveFolderId?: string;
  destinationDriveFolderName?: string;
  organization?: 'FLAT' | 'BY_YEAR';
  sourceEmail?: string;
  destinationEmail?: string;
}

export class PhotosMigrationService {
  /**
   * Create Photos Migration Job from a cumulative selection manifest
   */
  public async createPhotosJob(params: CreatePhotosJobParams): Promise<{
    jobId: string;
    manifestId: string;
    selectedCount: number;
    photosCount: number;
    videosCount: number;
    totalBytes: number;
  }> {
    const { userId, pickerSessionId, manifestId: inputManifestId, destinationDriveFolderId, organization = 'FLAT', sourceEmail, destinationEmail } = params;

    let pickerSession = null;
    if (pickerSessionId) {
      pickerSession = await prisma.photosPickerSession.findFirst({
        where: {
          OR: [{ id: pickerSessionId }, { pickerSessionId }],
          userId
        }
      });
    }

    const manifestId = inputManifestId || pickerSession?.manifestId || `photos-manifest-${Date.now()}`;
    const stats = await PhotosManifestStorage.getSummaryStats(manifestId).catch(() => null);

    let summary = {
      selectedCount: stats?.totalItems || pickerSession?.selectedCount || 0,
      photosCount: stats?.photosCount || pickerSession?.photosCount || 0,
      videosCount: stats?.videosCount || pickerSession?.videosCount || 0,
      totalBytes: stats?.totalBytes || Number(pickerSession?.totalBytes || 0),
      manifestId
    };

    if (summary.selectedCount === 0 && pickerSession) {
      summary = await photosPickerService.enumerateAndPersistSelectedItems(userId, pickerSession.pickerSessionId, manifestId);
    }

    const jobId = `photos-job-${Date.now()}`;

    if (summary.selectedCount === 0) {
      throw new Error('No photos or videos selected. Please select at least one item.');
    }

    const session = await prisma.migrationSession.create({
      data: {
        ownerId: userId,
        sourceEmail: sourceEmail || null,
        destinationEmail: destinationEmail || null,
        destinationFolderId: destinationDriveFolderId || 'root',
        manifestId,
        serviceType: 'PHOTOS',
        discoveryStatus: 'COMPLETED',
        migrationStatus: 'PREPARING'
      }
    });

    const job = await prisma.migrationJob.create({
      data: {
        id: jobId,
        ownerId: userId,
        sessionId: session.id,
        manifestId,
        serviceType: 'PHOTOS',
        organization,
        state: 'PREPARING',
        sourceFolderId: 'picker',
        destinationFolderId: destinationDriveFolderId || 'root',
        sourceEmail: sourceEmail || null,
        destinationEmail: destinationEmail || null,
        totalFiles: summary.selectedCount,
        photosCount: summary.photosCount,
        videosCount: summary.videosCount,
        totalBytes: BigInt(summary.totalBytes),
        currentAction: 'Preparing migration...'
      }
    });

    // Link Picker Session to Migration Job
    await prisma.photosPickerSession.update({
      where: { id: pickerSession.id },
      data: { migrationJobId: job.id }
    });

    console.log(`[PhotosMigrationService] Created Photos Migration Job ${jobId} with ${summary.selectedCount} selected items (Photos: ${summary.photosCount}, Videos: ${summary.videosCount})`);

    return {
      jobId: job.id,
      manifestId,
      selectedCount: summary.selectedCount,
      photosCount: summary.photosCount,
      videosCount: summary.videosCount,
      totalBytes: summary.totalBytes
    };
  }

  public async startMigration(jobId: string, userId: string, manifestId?: string): Promise<void> {
    const job = await prisma.migrationJob.findUnique({ where: { id: jobId } });
    if (!job || job.ownerId !== userId) throw new Error(`Migration job ${jobId} not found.`);

    const targetManifestId = job.manifestId || manifestId || jobId;

    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { state: 'COPYING', startedAt: new Date(), manifestId: targetManifestId }
    });

    photosMigrationWorker.executeMigration(jobId, userId, targetManifestId).catch(err => {
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
    if (!job || job.ownerId !== userId) throw new Error(`Migration job ${jobId} not found.`);

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
    if (!job || job.ownerId !== userId) throw new Error(`Migration job ${jobId} not found.`);

    const manifestId = job.manifestId || jobId;
    const count = await PhotosManifestStorage.resetFailedItems(manifestId, itemIds);

    if (count > 0 && ['COMPLETED', 'PAUSED', 'FAILED'].includes(job.state)) {
      this.resumeMigration(jobId, userId).catch(console.error);
    }

    return count;
  }
}

export const photosMigrationService = new PhotosMigrationService();
