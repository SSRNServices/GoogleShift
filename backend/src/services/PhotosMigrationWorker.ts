import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { google, drive_v3 } from 'googleapis';
import { googleClientManager } from '../auth/google.client';
import { defaultStorageProvider } from '../utils/storage/LocalStorageProvider';
import { PhotosManifestStorage, PhotosManifestItem } from '../utils/PhotosManifestStorage';
import { PhotosRateLimiter } from '../transfer/PhotosRateLimiter';
import { prisma, logJobEvent, updateJobProgress } from '../utils/database';
import { HttpErrorSanitizer } from '../utils/HttpErrorSanitizer';

export class PhotosMigrationWorker {
  private activeJobs: Map<string, { isRunning: boolean; isPaused: boolean; isCancelled: boolean }> = new Map();

  public async executeMigration(jobId: string, userId: string, manifestId: string): Promise<void> {
    console.log(`[PhotosWorker] Starting migration execution for jobId=${jobId}, manifestId=${manifestId}`);

    const jobControl = { isRunning: true, isPaused: false, isCancelled: false };
    this.activeJobs.set(jobId, jobControl);

    const job = await prisma.migrationJob.findUnique({ where: { id: jobId } });
    if (!job) {
      console.error(`[PhotosWorker] MigrationJob not found: ${jobId}`);
      this.activeJobs.delete(jobId);
      return;
    }

    // Retrieve authenticated OAuth clients for Photos (source) and Drive (destination)
    const sourceClient = await googleClientManager.getAuthenticatedClient(userId, 'photos-source');
    const destClient = await googleClientManager.getAuthenticatedClient(userId, 'destination');

    if (!sourceClient || !destClient) {
      await prisma.migrationJob.update({
        where: { id: jobId },
        data: {
          state: 'PAUSED',
          currentAction: 'AUTH_REQUIRED: Google Photos or Google Drive authorization is required. Please reconnect accounts.'
        }
      });
      await logJobEvent(jobId, '[AUTH_REQUIRED] Missing or expired Google Photos or Drive credentials.');
      this.activeJobs.delete(jobId);
      return;
    }

    const drive = google.drive({ version: 'v3', auth: destClient as any });
    const destinationDriveFolderId = job.destinationFolderId || 'root';
    const organization = job.organization || 'FLAT';
    const rateLimiter = new PhotosRateLimiter(4, 1, 10);

    // Initialize temporary directory in isolated, writable path
    const tempDir = path.join(defaultStorageProvider.getPhotosTempStoragePath(), jobId);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { state: 'COPYING', startedAt: new Date(), currentAction: 'Migrating selected photos and videos...' }
    });

    // Reset stuck states from previous process restarts
    await PhotosManifestStorage.resetIncompleteStatus(manifestId);

    // Map to cache Year Folder IDs in Drive for 'BY_YEAR' organization (e.g. '2026' -> 'drive_folder_id')
    const yearFolderMap = new Map<string, string>();

    const getTargetFolderForYear = async (year: string): Promise<string> => {
      if (organization !== 'BY_YEAR' || !year) {
        return destinationDriveFolderId;
      }

      if (yearFolderMap.has(year)) {
        return yearFolderMap.get(year)!;
      }

      try {
        // Search if year folder exists under destination folder
        const q = `name='${year}' and mimeType='application/vnd.google-apps.folder' and trashed=false${destinationDriveFolderId !== 'root' ? ` and '${destinationDriveFolderId}' in parents` : ''}`;
        const searchRes = await drive.files.list({
          q,
          fields: 'files(id, name)',
          pageSize: 1
        });

        if (searchRes.data.files && searchRes.data.files.length > 0) {
          const folderId = searchRes.data.files[0].id!;
          yearFolderMap.set(year, folderId);
          return folderId;
        }

        // Create year folder
        const createRes = await drive.files.create({
          requestBody: {
            name: year,
            mimeType: 'application/vnd.google-apps.folder',
            parents: destinationDriveFolderId !== 'root' ? [destinationDriveFolderId] : undefined
          },
          fields: 'id'
        });

        const newFolderId = createRes.data.id!;
        yearFolderMap.set(year, newFolderId);
        console.log(`[PhotosWorker] Created Year folder "${year}" in Drive: ${newFolderId}`);
        return newFolderId;
      } catch (err: any) {
        HttpErrorSanitizer.logError(`PhotosWorker.getTargetFolderForYear(${year})`, err);
        return destinationDriveFolderId; // Fallback to root destination
      }
    };

    const processItem = async (item: PhotosManifestItem): Promise<void> => {
      if (!jobControl.isRunning || jobControl.isCancelled) return;

      // Skip already verified items
      if (item.status === 'VERIFIED' || item.status === 'SKIPPED') {
        return;
      }

      // Check idempotency: if item has a destination Drive file ID, verify if it already exists on Drive
      if (item.destMediaId) {
        try {
          const existingFile = await drive.files.get({ fileId: item.destMediaId, fields: 'id, name' });
          if (existingFile.data && existingFile.data.id) {
            console.log(`[PhotosWorker] Item ${item.sourceFilename} (${item.sourceMediaId}) already uploaded to Drive (${item.destMediaId}). Marking VERIFIED.`);
            await PhotosManifestStorage.updateItemStatus(manifestId, item.id, 'VERIFIED', item.destMediaId, null, item.checksum);
            return;
          }
        } catch (_) {
          // File does not exist, proceed to re-upload
        }
      }

      await rateLimiter.acquireToken();

      const safeFilename = path.basename(item.sourceFilename || 'media_item');
      const tempFilePath = path.join(tempDir, `${item.id}_${Date.now()}_${safeFilename}`);
      let targetDriveFileId: string | null = null;

      try {
        await PhotosManifestStorage.updateItemStatus(manifestId, item.id, 'DOWNLOADING');

        // Fetch fresh OAuth access token for Google Photos download
        const photosTokenRes = await sourceClient.getAccessToken();
        const photosToken = photosTokenRes.token || sourceClient.credentials.access_token;
        if (!photosToken) {
          throw new Error('Google Photos OAuth access token unavailable.');
        }

        // Construct download URL
        const isVideo = item.mediaType === 'VIDEO';
        let downloadUrl = item.baseUrl;
        if (!downloadUrl) {
          downloadUrl = `https://photospicker.googleapis.com/v1/mediaItems/${item.sourceMediaId}`;
        }
        const mediaDownloadUrl = isVideo ? `${downloadUrl}=dv` : `${downloadUrl}=d`;

        // 1. Download media stream from Google Photos to local temp file while computing SHA-256 hash
        const response = await axios.get(mediaDownloadUrl, {
          headers: { Authorization: `Bearer ${photosToken}` },
          responseType: 'stream',
          timeout: 120000
        });

        const hash = crypto.createHash('sha256');
        const writeStream = fs.createWriteStream(tempFilePath);

        await new Promise<void>((resolve, reject) => {
          response.data.on('data', (chunk: Buffer) => hash.update(chunk));
          response.data.pipe(writeStream);
          writeStream.on('finish', () => resolve());
          writeStream.on('error', (err: any) => reject(err));
          response.data.on('error', (err: any) => reject(err));
        });

        const calculatedChecksum = hash.digest('hex');
        const stat = await fs.promises.stat(tempFilePath);
        const fileSize = stat.size;

        await PhotosManifestStorage.updateItemStatus(manifestId, item.id, 'UPLOADING');

        // Extract creation year for organization
        let year = '';
        if (item.creationTime) {
          const parsedDate = new Date(item.creationTime);
          if (!isNaN(parsedDate.getTime())) {
            year = parsedDate.getFullYear().toString();
          }
        }
        const targetFolderId = await getTargetFolderForYear(year);

        // 2. Upload stream to Google Drive
        const readStream = fs.createReadStream(tempFilePath);
        const driveCreateRes = await drive.files.create({
          requestBody: {
            name: item.sourceFilename,
            mimeType: item.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
            parents: targetFolderId !== 'root' ? [targetFolderId] : undefined
          },
          media: {
            mimeType: item.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
            body: readStream
          },
          fields: 'id, name, size, mimeType, parents'
        });

        targetDriveFileId = driveCreateRes.data.id || null;
        if (!targetDriveFileId) {
          throw new Error('Google Drive API failed to return a valid file ID.');
        }

        await PhotosManifestStorage.updateItemStatus(manifestId, item.id, 'VERIFYING', targetDriveFileId, null, calculatedChecksum);

        // 3. Post-upload verification: query Drive file metadata
        const verifyRes = await drive.files.get({
          fileId: targetDriveFileId,
          fields: 'id, name, mimeType, size, parents'
        });

        if (!verifyRes.data || !verifyRes.data.id) {
          throw new Error('Verification failed: uploaded file not found on Google Drive.');
        }

        await PhotosManifestStorage.updateItemStatus(manifestId, item.id, 'VERIFIED', targetDriveFileId, null, calculatedChecksum);
        rateLimiter.reportSuccess();
        console.log(`[PhotosWorker] VERIFIED | Item: ${item.sourceFilename} (${item.mediaType}) -> Drive FileId: ${targetDriveFileId}`);

      } catch (err: any) {
        HttpErrorSanitizer.logError(`PhotosWorker.processItem(${item.id})`, err);
        const info = HttpErrorSanitizer.extractSanitizedInfo(err);

        const isAuthError = info.status === 401 || info.message.includes('invalid_grant');
        const isRateLimit = info.status === 429 || info.message.includes('429');

        if (isAuthError) {
          console.error(`[PhotosWorker] AUTH REQUIRED on item ${item.id}. Pausing migration.`);
          jobControl.isPaused = true;
          await prisma.migrationJob.update({
            where: { id: jobId },
            data: {
              state: 'PAUSED',
              currentAction: 'AUTH_REQUIRED: Authorization expired. Please reconnect Google account and resume.'
            }
          });
          return;
        }

        const retryCount = await PhotosManifestStorage.incrementRetryCount(manifestId, item.id);
        const maxRetries = 5;

        if (isRateLimit || retryCount <= maxRetries) {
          const delayMs = rateLimiter.reportRateLimit(isRateLimit ? 10 : Math.pow(2, retryCount));
          console.warn(`[PhotosWorker] RETRY | Item: ${item.sourceFilename} | Attempt: ${retryCount}/${maxRetries} | Error: ${info.message}`);
          await PhotosManifestStorage.updateItemStatus(manifestId, item.id, 'QUEUED', targetDriveFileId, `Retry ${retryCount}: ${info.message}`);
        } else {
          console.error(`[PhotosWorker] FAILED | Item: ${item.sourceFilename} | Exhausted ${maxRetries} retries | Error: ${info.message}`);
          await PhotosManifestStorage.updateItemStatus(manifestId, item.id, 'FAILED', targetDriveFileId, info.message);
        }
      } finally {
        // Immediate clean up of temporary file
        if (fs.existsSync(tempFilePath)) {
          await fs.promises.unlink(tempFilePath).catch(() => {});
        }
      }
    };

    // Main Worker Loop
    let lastProgressEmit = 0;
    const maxConcurrency = rateLimiter.getConcurrency();

    while (jobControl.isRunning && !jobControl.isPaused && !jobControl.isCancelled) {
      const pendingItems = await PhotosManifestStorage.getPendingFiles(manifestId, maxConcurrency);
      
      if (pendingItems.length === 0) {
        // Check if all items are in terminal states
        const stats = await PhotosManifestStorage.getSummaryStats(manifestId);
        if (stats.pendingItems === 0) {
          console.log(`[PhotosWorker] All items processed for jobId=${jobId}. Finalizing migration...`);
          const finalState = 'COMPLETED';
          const currentAction = stats.failedItems > 0 ? `Completed with ${stats.failedItems} failed items` : 'Migration Completed Successfully';

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
              currentAction
            }
          });

          await logJobEvent(jobId, `[STATE] COMPLETED - Final Verified: ${stats.completedItems}/${stats.totalItems}, Failed: ${stats.failedItems}`);
          break;
        }
      }

      await Promise.all(pendingItems.map(item => processItem(item)));

      // Emit live progress to DB every 2 seconds
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
          currentAction: `Migrating photos & videos (${stats.completedItems}/${stats.totalItems})...`
        });
      }
    }

    // Cleanup job temp directory
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
