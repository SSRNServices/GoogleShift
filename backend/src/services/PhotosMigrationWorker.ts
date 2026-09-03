import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { googleClientManager } from '../auth/google.client';
import { GooglePhotosProvider } from '../providers/GooglePhotosProvider';
import { PhotosManifestStorage, PhotosManifestItem, PhotosAlbumItem } from '../utils/PhotosManifestStorage';
import { PhotosRateLimiter } from '../transfer/PhotosRateLimiter';
import { prisma, logJobEvent, updateJobProgress } from '../utils/database';

export class PhotosMigrationWorker {
  private activeJobs: Map<string, { isRunning: boolean; isPaused: boolean; isCancelled: boolean }> = new Map();

  public async executeMigration(jobId: string, userId: string, manifestId: string): Promise<void> {
    console.log(`[PhotosWorker] Starting migration execution for jobId=${jobId}, manifestId=${manifestId}`);

    const jobControl = { isRunning: true, isPaused: false, isCancelled: false };
    this.activeJobs.set(jobId, jobControl);

    const sourceClient = await googleClientManager.getAuthenticatedClient(userId, 'photos-source');
    const destClient = await googleClientManager.getAuthenticatedClient(userId, 'photos-destination');

    if (!sourceClient || !destClient) {
      await prisma.migrationJob.update({
        where: { id: jobId },
        data: { state: 'PAUSED', currentAction: 'AUTH_REQUIRED: Please reconnect source & destination Google Photos accounts.' }
      });
      await logJobEvent(jobId, '[AUTH_REQUIRED] Missing or expired Google Photos credentials.');
      return;
    }

    const sourceProvider = new GooglePhotosProvider(sourceClient);
    const destProvider = new GooglePhotosProvider(destClient);
    const rateLimiter = new PhotosRateLimiter(4, 1, 10);

    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { state: 'COPYING', startedAt: new Date(), currentAction: 'Migrating photos and videos...' }
    });

    // Step 1: Reconstruct Albums in Destination
    const albumMap = new Map<string, string>(); // sourceAlbumId -> destAlbumId
    try {
      const albums = await PhotosManifestStorage.getAlbums(manifestId);
      for (const alb of albums) {
        if (!jobControl.isRunning || jobControl.isCancelled) break;
        if (alb.destAlbumId && alb.status === 'CREATED') {
          albumMap.set(alb.sourceAlbumId, alb.destAlbumId);
          continue;
        }

        try {
          await PhotosManifestStorage.updateAlbumStatus(manifestId, alb.sourceAlbumId, 'CREATING');
          const created = await destProvider.createAlbum(alb.title);
          if (created && created.id) {
            albumMap.set(alb.sourceAlbumId, created.id);
            await PhotosManifestStorage.updateAlbumStatus(manifestId, alb.sourceAlbumId, 'CREATED', created.id);
            console.log(`[PhotosWorker] Created destination album "${alb.title}" (destId=${created.id})`);
          }
        } catch (albErr: any) {
          console.error(`[PhotosWorker] Failed to create album "${alb.title}": ${albErr.message}`);
          await PhotosManifestStorage.updateAlbumStatus(manifestId, alb.sourceAlbumId, 'FAILED', null, albErr.message);
        }
      }
    } catch (e: any) {
      console.warn(`[PhotosWorker] Album setup warning: ${e.message}`);
    }

    // Step 2: Recover any stuck item states from previous crashed process
    await PhotosManifestStorage.resetIncompleteStatus(manifestId);

    // Step 3: Process Media Items with Bounded Worker Pool
    const tempDir = path.join(process.cwd(), 'scratch', 'photos_temp', jobId);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    let activeWorkerCount = 0;
    const maxConcurrency = rateLimiter.getConcurrency();

    const processItem = async (item: PhotosManifestItem): Promise<void> => {
      if (!jobControl.isRunning || jobControl.isCancelled) return;

      // Deduplication check
      if (item.status === 'SUCCESS' || item.status === 'VERIFIED') {
        console.log(`[PhotosWorker] Item ${item.id} already completed. Skipping.`);
        return;
      }

      await rateLimiter.acquireToken();

      const tempFilePath = path.join(tempDir, `${item.id}_${Date.now()}_${path.basename(item.sourceFilename)}`);
      let itemSuccess = false;

      try {
        await PhotosManifestStorage.updateItemStatus(manifestId, item.id, 'DOWNLOADING');

        // Fetch source media details to obtain fresh baseUrl
        // Download raw stream with hashing
        const sourceMediaRes = await sourceProvider.listMediaItems();
        // Fallback: download directly using sourceMediaId baseUrl search or direct stream
        let baseUrl = `https://photoslibrary.googleapis.com/v1/mediaItems/${item.sourceMediaId}`;
        const isVideo = item.mediaType === 'VIDEO';

        // 1. Download stream to temporary file with sha256 checksum computation
        const readStream = await sourceProvider.downloadMediaStream(baseUrl, isVideo);
        const hash = crypto.createHash('sha256');
        const writeStream = fs.createWriteStream(tempFilePath);

        await new Promise<void>((resolve, reject) => {
          readStream.on('data', chunk => hash.update(chunk));
          readStream.pipe(writeStream);
          writeStream.on('finish', () => resolve());
          writeStream.on('error', err => reject(err));
          readStream.on('error', err => reject(err));
        });

        const calculatedChecksum = hash.digest('hex');
        const stat = await fs.promises.stat(tempFilePath);
        const fileSize = stat.size;

        await PhotosManifestStorage.updateItemStatus(manifestId, item.id, 'UPLOADING');

        // 2. Upload file stream to destination Google Photos
        const uploadStream = fs.createReadStream(tempFilePath);
        const uploadToken = await destProvider.uploadMediaStream(uploadStream, item.mimeType, item.sourceFilename, fileSize);

        // 3. Batch create media item in destination library
        // Map destination album IDs if media item belonged to albums
        const destAlbumIds: string[] = [];
        for (const srcAlbId of item.albumIds) {
          const mapped = albumMap.get(srcAlbId);
          if (mapped) destAlbumIds.push(mapped);
        }

        const targetAlbumId = destAlbumIds.length > 0 ? destAlbumIds[0] : undefined;
        const batchResults = await destProvider.batchCreateMediaItems(
          [{ uploadToken, fileName: item.sourceFilename }],
          targetAlbumId
        );

        const result = batchResults[0];
        if (!result || !result.mediaItem?.id) {
          const errMsg = result?.status?.message || 'Failed to create media item in destination Google Photos library.';
          throw new Error(errMsg);
        }

        const destMediaId = result.mediaItem.id;

        // 4. Assign to additional destination albums if item belonged to multiple albums
        if (destAlbumIds.length > 1) {
          for (let i = 1; i < destAlbumIds.length; i++) {
            await destProvider.batchAddMediaItemsToAlbum(destAlbumIds[i], [destMediaId]).catch(() => {});
          }
        }

        // 5. Verification: Verify destinationMediaId is non-empty
        await PhotosManifestStorage.updateItemStatus(manifestId, item.id, 'SUCCESS', destMediaId, null, calculatedChecksum);
        rateLimiter.reportSuccess();
        itemSuccess = true;
        console.log(`[PhotosWorker] SUCCESS | Item: ${item.sourceFilename} | DestId: ${destMediaId}`);

      } catch (err: any) {
        const errorMsg = err.message || 'Unknown transfer error';
        const isAuthError = err.response?.status === 401 || errorMsg.includes('invalid_grant');
        const isRateLimit = err.response?.status === 429 || errorMsg.includes('429');

        if (isAuthError) {
          console.error(`[PhotosWorker] AUTH ERROR on item ${item.id}. Pausing job.`);
          jobControl.isPaused = true;
          await prisma.migrationJob.update({
            where: { id: jobId },
            data: { state: 'PAUSED', currentAction: 'AUTH_REQUIRED: Destination token expired. Please reconnect account.' }
          });
          return;
        }

        const retryCount = await PhotosManifestStorage.incrementRetryCount(manifestId, item.id);
        const maxRetries = 5;

        if (isRateLimit || retryCount <= maxRetries) {
          const delayMs = rateLimiter.reportRateLimit(isRateLimit ? 10 : Math.pow(2, retryCount));
          console.warn(`[PhotosWorker] RETRY | Item: ${item.id} | Attempt: ${retryCount}/${maxRetries} | Error: ${errorMsg}`);
          await PhotosManifestStorage.updateItemStatus(manifestId, item.id, 'QUEUED', null, `Retry ${retryCount}: ${errorMsg}`);
        } else {
          console.error(`[PhotosWorker] PERMANENT FAILURE | Item: ${item.id} | Exhausted ${maxRetries} retries | Error: ${errorMsg}`);
          await PhotosManifestStorage.updateItemStatus(manifestId, item.id, 'FAILED', null, errorMsg);
        }
      } finally {
        // Guaranteed Temporary File Cleanup
        if (fs.existsSync(tempFilePath)) {
          await fs.promises.unlink(tempFilePath).catch(() => {});
        }
      }
    };

    // Main Work Loop
    let lastProgressEmit = 0;
    while (jobControl.isRunning && !jobControl.isPaused && !jobControl.isCancelled) {
      const pendingItems = await PhotosManifestStorage.getPendingFiles(manifestId, maxConcurrency);
      if (pendingItems.length === 0) {
        // Check if all items are terminal
        const stats = await PhotosManifestStorage.getSummaryStats(manifestId);
        if (stats.pendingItems === 0) {
          console.log(`[PhotosWorker] All items processed for jobId=${jobId}. Finalizing...`);
          const finalState = stats.failedItems > 0 ? 'COMPLETED' : 'COMPLETED';
          await prisma.migrationJob.update({
            where: { id: jobId },
            data: {
              state: finalState,
              completedAt: new Date(),
              completedFiles: stats.completedItems,
              failedFiles: stats.failedItems,
              totalFiles: stats.totalItems,
              transferredBytes: BigInt(stats.transferredBytes),
              totalBytes: BigInt(stats.totalBytes),
              photosCount: stats.photosCount,
              videosCount: stats.videosCount,
              albumsCount: stats.albumsCount,
              currentAction: stats.failedItems > 0 ? 'Completed with Errors' : 'Completed'
            }
          });
          await logJobEvent(jobId, `[STATE] COMPLETED - Final Status: ${stats.failedItems > 0 ? 'completed_with_errors' : 'completed'}`);
          break;
        }
      }

      await Promise.all(pendingItems.map(item => processItem(item)));

      // Emit Live Progress to DB
      const now = Date.now();
      if (now - lastProgressEmit > 2000) {
        lastProgressEmit = now;
        const stats = await PhotosManifestStorage.getSummaryStats(manifestId);
        await updateJobProgress(jobId, {
          completedFiles: stats.completedItems,
          failedFiles: stats.failedItems,
          totalFiles: stats.totalItems,
          transferredBytes: BigInt(stats.transferredBytes),
          totalBytes: BigInt(stats.totalBytes),
          speed: 0,
          averageSpeed: 0,
          eta: 0,
          currentAction: `Migrating items (${stats.completedItems}/${stats.totalItems})...`
        });
      }
    }

    // Cleanup Scratch Temp Directory on Completion or Cancel
    try {
      if (fs.existsSync(tempDir)) {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (_) {}

    this.activeJobs.delete(jobId);
    console.log(`[PhotosWorker] Execution finished for jobId=${jobId}`);
  }

  public pauseJob(jobId: string): void {
    const handle = this.activeJobs.get(jobId);
    if (handle) {
      handle.isPaused = true;
      console.log(`[PhotosWorker] Pause requested for jobId=${jobId}`);
    }
  }

  public cancelJob(jobId: string): void {
    const handle = this.activeJobs.get(jobId);
    if (handle) {
      handle.isCancelled = true;
      handle.isRunning = false;
      console.log(`[PhotosWorker] Cancel requested for jobId=${jobId}`);
    }
  }
}

export const photosMigrationWorker = new PhotosMigrationWorker();
