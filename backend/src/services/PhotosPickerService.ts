import axios from 'axios';
import { prisma } from '../utils/database';
import { googleClientManager } from '../auth/google.client';
import { PhotosManifestStorage, PhotosManifestItem } from '../utils/PhotosManifestStorage';
import { HttpErrorSanitizer } from '../utils/HttpErrorSanitizer';
import { authService } from '../auth/auth.service';
import { GoogleApiErrorClassifier, PhotosErrorCode } from '../utils/GoogleApiErrorClassifier';

export interface PickerSessionResult {
  id: string;
  pickerSessionId: string;
  pickerUri: string;
  status: string;
  mediaItemsSet: boolean;
  selectedCount: number;
  photosCount: number;
  videosCount: number;
  totalBytes: number;
  expiresAt: string;
  manifestId?: string;
}

export class PhotosPickerService {
  private readonly pickerApiBase = 'https://photospicker.googleapis.com/v1';

  /**
   * Create a Google Photos Picker Session for the user
   */
  public async createPickerSession(userId: string, manifestId?: string): Promise<PickerSessionResult> {
    const authStatus = await authService.isPhotosPickerAuthorized(userId);
    if (!authStatus.pickerAuthorized) {
      console.warn(`[PhotosPicker] Pre-check failed for userId=${userId}: ${authStatus.reason}`);
      const err = new Error(`PHOTOS_AUTH_REQUIRED: ${authStatus.reason || 'Google Photos permission required.'}`);
      (err as any).code = 'PHOTOS_AUTH_REQUIRED';
      (err as any).statusCode = 403;
      throw err;
    }

    const client = await googleClientManager.getAuthenticatedClient(userId, 'photos-source');
    if (!client) {
      const err = new Error('PHOTOS_AUTH_REQUIRED: Google Photos account is not connected. Please connect Google Photos first.');
      (err as any).code = 'PHOTOS_AUTH_REQUIRED';
      (err as any).statusCode = 403;
      throw err;
    }

    const tokenRes = await client.getAccessToken();
    const accessToken = tokenRes.token || client.credentials.access_token;
    if (!accessToken) {
      const err = new Error('PHOTOS_AUTH_REQUIRED: Google Photos access token is missing or expired.');
      (err as any).code = 'PHOTOS_AUTH_REQUIRED';
      (err as any).statusCode = 403;
      throw err;
    }

    const targetManifestId = manifestId || `photos-manifest-${Date.now()}`;

    const requestPayload = {
      pickingConfig: {
        maxItemCount: 2000
      }
    };

    try {
      console.log(`[PhotosPicker] Creating picker session for userId=${userId}, manifestId=${targetManifestId}, payload=${JSON.stringify(requestPayload)}...`);
      const response = await axios.post(
        `${this.pickerApiBase}/sessions`,
        requestPayload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      const sessionData = response.data;
      const pickerSessionId = sessionData.id || sessionData.name;
      let pickerUri = sessionData.pickerUri || '';

      if (!pickerSessionId || !pickerUri) {
        throw new Error('Invalid response from Google Photos Picker API: missing session ID or picker URI.');
      }

      if (!pickerUri.includes('/autoclose')) {
        pickerUri = pickerUri.endsWith('/') ? `${pickerUri}autoclose` : `${pickerUri}/autoclose`;
      }

      const expireTimeStr = sessionData.expireTime || sessionData.expiresAt;
      const expiresAt = expireTimeStr ? new Date(expireTimeStr) : new Date(Date.now() + 30 * 60 * 1000);

      const dbSession = await prisma.photosPickerSession.create({
        data: {
          pickerSessionId,
          pickerUri,
          userId,
          manifestId: targetManifestId,
          status: 'CREATED',
          expiresAt
        }
      });

      console.log(`[PhotosPicker] Picker session created cleanly. DB ID=${dbSession.id}, GoogleSessionId=${pickerSessionId}, ManifestId=${targetManifestId}`);

      return {
        id: dbSession.id,
        pickerSessionId,
        pickerUri,
        status: dbSession.status,
        mediaItemsSet: false,
        selectedCount: 0,
        photosCount: 0,
        videosCount: 0,
        totalBytes: 0,
        expiresAt: expiresAt.toISOString(),
        manifestId: targetManifestId
      };
    } catch (err: any) {
      HttpErrorSanitizer.logError('PhotosPickerService.createPickerSession', err);
      const classified = GoogleApiErrorClassifier.classify(err);

      console.error(`[PhotosPicker] Session creation failed (Status ${classified.statusCode}): ${classified.code} - ${classified.userMessage}`);

      const classifiedErr = new Error(`${classified.code}: ${classified.userMessage}`);
      (classifiedErr as any).code = classified.code;
      (classifiedErr as any).statusCode = classified.statusCode;
      throw classifiedErr;
    }
  }

  /**
   * Check status of a Google Photos Picker Session
   */
  public async getPickerSessionStatus(userId: string, dbSessionId: string): Promise<PickerSessionResult> {
    const dbSession = await prisma.photosPickerSession.findFirst({
      where: {
        userId,
        OR: [
          { id: dbSessionId },
          { pickerSessionId: dbSessionId }
        ]
      }
    });

    if (!dbSession) {
      throw new Error('Picker session not found.');
    }

    if (dbSession.status === 'CREATED' && new Date() > dbSession.expiresAt) {
      await prisma.photosPickerSession.update({
        where: { id: dbSession.id },
        data: { status: 'EXPIRED' }
      });
      dbSession.status = 'EXPIRED';
    }

    let selectedCount = dbSession.selectedCount;
    let photosCount = dbSession.photosCount;
    let videosCount = dbSession.videosCount;
    let totalBytes = Number(dbSession.totalBytes);

    if (dbSession.manifestId) {
      const stats = await PhotosManifestStorage.getSummaryStats(dbSession.manifestId).catch(() => null);
      if (stats) {
        selectedCount = stats.totalItems;
        photosCount = stats.photosCount;
        videosCount = stats.videosCount;
        totalBytes = stats.totalBytes;
      }
    }

    if (dbSession.mediaItemsSet || dbSession.status === 'SELECTION_COMPLETE' || dbSession.status === 'CLEANED_UP') {
      return {
        id: dbSession.id,
        pickerSessionId: dbSession.pickerSessionId,
        pickerUri: dbSession.pickerUri,
        status: dbSession.status,
        mediaItemsSet: true,
        selectedCount,
        photosCount,
        videosCount,
        totalBytes,
        expiresAt: dbSession.expiresAt.toISOString(),
        manifestId: dbSession.manifestId || undefined
      };
    }

    const client = await googleClientManager.getAuthenticatedClient(userId, 'photos-source');
    if (!client) {
      return {
        id: dbSession.id,
        pickerSessionId: dbSession.pickerSessionId,
        pickerUri: dbSession.pickerUri,
        status: dbSession.status,
        mediaItemsSet: false,
        selectedCount: 0,
        photosCount: 0,
        videosCount: 0,
        totalBytes: 0,
        expiresAt: dbSession.expiresAt.toISOString(),
        manifestId: dbSession.manifestId || undefined
      };
    }

    const tokenRes = await client.getAccessToken();
    const accessToken = tokenRes.token || client.credentials.access_token;
    if (!accessToken) {
      return {
        id: dbSession.id,
        pickerSessionId: dbSession.pickerSessionId,
        pickerUri: dbSession.pickerUri,
        status: dbSession.status,
        mediaItemsSet: false,
        selectedCount: 0,
        photosCount: 0,
        videosCount: 0,
        totalBytes: 0,
        expiresAt: dbSession.expiresAt.toISOString(),
        manifestId: dbSession.manifestId || undefined
      };
    }

    try {
      const response = await axios.get(`${this.pickerApiBase}/sessions/${dbSession.pickerSessionId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000
      });

      const sessionData = response.data;
      const mediaItemsSet = !!sessionData.mediaItemsSet;

      if (mediaItemsSet && !dbSession.mediaItemsSet) {
        await prisma.photosPickerSession.update({
          where: { id: dbSession.id },
          data: { mediaItemsSet: true, status: 'SELECTION_COMPLETE' }
        });
      }

      return {
        id: dbSession.id,
        pickerSessionId: dbSession.pickerSessionId,
        pickerUri: dbSession.pickerUri,
        status: mediaItemsSet ? 'SELECTION_COMPLETE' : dbSession.status,
        mediaItemsSet,
        selectedCount,
        photosCount,
        videosCount,
        totalBytes,
        expiresAt: dbSession.expiresAt.toISOString(),
        manifestId: dbSession.manifestId || undefined
      };
    } catch (err: any) {
      HttpErrorSanitizer.logError('PhotosPickerService.getPickerSessionStatus', err);
      const classified = GoogleApiErrorClassifier.classify(err);

      if (classified.code === PhotosErrorCode.PHOTOS_PICKER_SESSION_NOT_FOUND && dbSession.manifestId) {
        const stats = await PhotosManifestStorage.getSummaryStats(dbSession.manifestId).catch(() => null);
        if (stats && stats.totalItems > 0) {
          console.warn(`[PhotosPicker] Session ${dbSession.pickerSessionId} 404'd on Google API, but local manifest ${dbSession.manifestId} has ${stats.totalItems} items. Treating as SELECTION_COMPLETE.`);
          return {
            id: dbSession.id,
            pickerSessionId: dbSession.pickerSessionId,
            pickerUri: dbSession.pickerUri,
            status: 'SELECTION_COMPLETE',
            mediaItemsSet: true,
            selectedCount: stats.totalItems,
            photosCount: stats.photosCount,
            videosCount: stats.videosCount,
            totalBytes: stats.totalBytes,
            expiresAt: dbSession.expiresAt.toISOString(),
            manifestId: dbSession.manifestId
          };
        }
      }

      return {
        id: dbSession.id,
        pickerSessionId: dbSession.pickerSessionId,
        pickerUri: dbSession.pickerUri,
        status: dbSession.status,
        mediaItemsSet: dbSession.mediaItemsSet,
        selectedCount,
        photosCount,
        videosCount,
        totalBytes,
        expiresAt: dbSession.expiresAt.toISOString(),
        manifestId: dbSession.manifestId || undefined
      };
    }
  }

  /**
   * Enumerate selected media items from Google Photos Picker Session and persist them to SQLite manifest
   */
  public async enumerateAndPersistSelectedItems(
    userId: string,
    dbSessionId: string,
    targetManifestId?: string
  ): Promise<{
    selectedCount: number;
    photosCount: number;
    videosCount: number;
    totalBytes: number;
    manifestId: string;
    batches?: any[];
    batchAdded?: any;
  }> {
    const dbSession = await prisma.photosPickerSession.findFirst({
      where: {
        userId,
        OR: [
          { id: dbSessionId },
          { pickerSessionId: dbSessionId }
        ]
      }
    });

    if (!dbSession) {
      throw new Error('Picker session not found.');
    }

    if ((dbSession.status === 'SELECTION_COMPLETE' || dbSession.status === 'CLEANED_UP') && dbSession.manifestId) {
      console.log(`[PhotosPicker] Session ${dbSession.pickerSessionId} already completed with manifestId=${dbSession.manifestId}. Returning cached selection stats.`);
      const cachedStats = await PhotosManifestStorage.getSummaryStats(dbSession.manifestId).catch(() => null);
      if (cachedStats) {
        return {
          selectedCount: cachedStats.totalItems,
          photosCount: cachedStats.photosCount,
          videosCount: cachedStats.videosCount,
          totalBytes: cachedStats.totalBytes,
          manifestId: dbSession.manifestId,
          batches: cachedStats.batches
        };
      }
    }

    if (dbSession.status === 'ENUMERATING') {
      console.log(`[PhotosPicker] Session ${dbSession.pickerSessionId} is currently being enumerated by another request.`);
      let attempts = 0;
      while (attempts < 10) {
        await new Promise(r => setTimeout(r, 500));
        attempts++;
        const current = await prisma.photosPickerSession.findUnique({ where: { id: dbSession.id } });
        if (current && (current.status === 'SELECTION_COMPLETE' || current.status === 'CLEANED_UP') && current.manifestId) {
          const cachedStats = await PhotosManifestStorage.getSummaryStats(current.manifestId).catch(() => null);
          return {
            selectedCount: cachedStats?.totalItems || current.selectedCount,
            photosCount: cachedStats?.photosCount || current.photosCount,
            videosCount: cachedStats?.videosCount || current.videosCount,
            totalBytes: cachedStats?.totalBytes || Number(current.totalBytes),
            manifestId: current.manifestId,
            batches: cachedStats?.batches || []
          };
        }
      }
    }

    await prisma.photosPickerSession.update({
      where: { id: dbSession.id },
      data: { status: 'ENUMERATING' }
    });

    const manifestId = dbSession.manifestId || targetManifestId || `photos-manifest-${Date.now()}`;

    const client = await googleClientManager.getAuthenticatedClient(userId, 'photos-source');
    if (!client) {
      throw new Error('Google Photos account is not connected.');
    }

    const tokenRes = await client.getAccessToken();
    const accessToken = tokenRes.token || client.credentials.access_token;
    if (!accessToken) {
      throw new Error('Google Photos access token is missing or expired.');
    }

    let pageToken: string | undefined = undefined;
    let totalSelected = 0;
    let photosCount = 0;
    let videosCount = 0;
    let totalBytes = 0;
    let batchNewCount = 0;
    let batchDuplicateCount = 0;
    let itemSeq = 0;

    console.log(`[PhotosPicker] Starting media enumeration for sessionId=${dbSession.pickerSessionId}, manifestId=${manifestId}`);

    do {
      try {
        const response: any = await axios.get(`${this.pickerApiBase}/mediaItems`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            sessionId: dbSession.pickerSessionId,
            pageSize: 100,
            ...(pageToken ? { pageToken } : {})
          },
          timeout: 20000
        });

        const rawItems: any[] = response.data.mediaItems || [];
        pageToken = response.data.nextPageToken || undefined;

        if (rawItems.length > 0) {
          const manifestItems: PhotosManifestItem[] = [];

          for (const rawItem of rawItems) {
            itemSeq++;
            const sourceMediaId = rawItem.id || `media_${itemSeq}`;
            const mediaFile = rawItem.mediaFile || rawItem;
            const mimeType = mediaFile.mimeType || 'image/jpeg';
            const isVideo = mimeType.toLowerCase().startsWith('video/');
            const mediaType: 'PHOTO' | 'VIDEO' = isVideo ? 'VIDEO' : 'PHOTO';
            const size = mediaFile.sizeBytes ? Number(mediaFile.sizeBytes) : (mediaFile.size ? Number(mediaFile.size) : 0);
            const creationTime = mediaFile.mediaFileMetadata?.creationTime || mediaFile.createTime || new Date().toISOString();

            let filename = mediaFile.filename || rawItem.filename;
            if (!filename) {
              const ext = isVideo ? 'mp4' : (mimeType.includes('png') ? 'png' : 'jpg');
              const prefix = isVideo ? 'VID' : 'IMG';
              filename = `${prefix}_${Date.now()}_${itemSeq}.${ext}`;
            }

            manifestItems.push({
              id: `item_${manifestId}_${itemSeq}_${Math.random().toString(36).substring(2, 7)}`,
              jobId: manifestId,
              sourceMediaId,
              sourceFilename: filename,
              mimeType,
              size,
              creationTime,
              baseUrl: mediaFile.baseUrl || rawItem.baseUrl || null,
              mediaType,
              albumIds: [],
              destAlbumIds: [],
              destMediaId: null,
              checksum: null,
              status: 'PENDING',
              retryCount: 0,
              error: null,
              lastAttemptAt: null,
              verifiedAt: null,
              createdAt: Date.now()
            });

            totalSelected++;
            if (isVideo) videosCount++;
            else photosCount++;
            totalBytes += size;
          }

          const saveRes = await PhotosManifestStorage.saveMediaItemsChunk(manifestId, manifestItems);
          batchNewCount += saveRes.newCount;
          batchDuplicateCount += saveRes.duplicateCount;

          console.log(`[PhotosPicker] Persisted chunk of ${manifestItems.length} items to manifest ${manifestId}. (Batch total: ${totalSelected}, New: ${batchNewCount}, Dupes: ${batchDuplicateCount})`);
        }
      } catch (err: any) {
        HttpErrorSanitizer.logError('PhotosPickerService.enumerateAndPersistSelectedItems', err);
        const classified = GoogleApiErrorClassifier.classify(err);

        if (classified.code === PhotosErrorCode.PHOTOS_PICKER_SESSION_NOT_FOUND && totalSelected > 0) {
          console.warn(`[PhotosPicker] Session ${dbSession.pickerSessionId} returned 404 during pagination, but ${totalSelected} items were already persisted.`);
          break;
        }

        const classifiedErr = new Error(`${classified.code}: ${classified.userMessage}`);
        (classifiedErr as any).code = classified.code;
        (classifiedErr as any).statusCode = classified.statusCode;
        throw classifiedErr;
      }
    } while (pageToken);

    const existingBatches = await PhotosManifestStorage.getBatches(manifestId);
    const batchNumber = existingBatches.length + 1;

    await PhotosManifestStorage.recordBatch(manifestId, {
      id: `batch_${dbSession.id}`,
      manifestId,
      pickerSessionId: dbSession.pickerSessionId,
      batchNumber,
      selectedCount: totalSelected,
      newCount: batchNewCount,
      duplicateCount: batchDuplicateCount,
      photosCount,
      videosCount,
      totalBytes,
      status: 'COMPLETED',
      createdAt: Date.now()
    });

    await prisma.photosPickerSession.update({
      where: { id: dbSession.id },
      data: {
        status: 'SELECTION_COMPLETE',
        mediaItemsSet: true,
        manifestId,
        selectedCount: totalSelected,
        photosCount,
        videosCount,
        totalBytes: BigInt(totalBytes)
      }
    });

    try {
      await axios.delete(`${this.pickerApiBase}/sessions/${dbSession.pickerSessionId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 5000
      });
      console.log(`[PhotosPicker] Successfully cleaned up Google Picker session ${dbSession.pickerSessionId}`);
      await prisma.photosPickerSession.update({
        where: { id: dbSession.id },
        data: { status: 'CLEANED_UP' }
      }).catch(() => null);
    } catch (cleanupErr: any) {
      console.warn(`[PhotosPicker] Non-fatal warning: Google Picker session deletion returned: ${cleanupErr.message}`);
    }

    const cumulativeStats = await PhotosManifestStorage.getSummaryStats(manifestId);

    return {
      selectedCount: cumulativeStats.totalItems,
      photosCount: cumulativeStats.photosCount,
      videosCount: cumulativeStats.videosCount,
      totalBytes: cumulativeStats.totalBytes,
      manifestId,
      batches: cumulativeStats.batches,
      batchAdded: {
        batchNumber,
        selectedCount: totalSelected,
        newCount: batchNewCount,
        duplicateCount: batchDuplicateCount
      }
    };
  }
}

export const photosPickerService = new PhotosPickerService();
