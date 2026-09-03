import axios from 'axios';
import { prisma } from '../utils/database';
import { googleClientManager } from '../auth/google.client';
import { PhotosManifestStorage, PhotosManifestItem } from '../utils/PhotosManifestStorage';
import { HttpErrorSanitizer } from '../utils/HttpErrorSanitizer';

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
}

export class PhotosPickerService {
  private pickerApiBase = 'https://photospicker.googleapis.com/v1';

  /**
   * Create a Google Photos Picker Session for the user
   */
  public async createPickerSession(userId: string): Promise<PickerSessionResult> {
    const client = await googleClientManager.getAuthenticatedClient(userId, 'photos-source');
    if (!client) {
      throw new Error('Google Photos account is not connected. Please connect Google Photos first.');
    }

    const tokenRes = await client.getAccessToken();
    const accessToken = tokenRes.token || client.credentials.access_token;
    if (!accessToken) {
      throw new Error('Google Photos access token is missing or expired.');
    }

    try {
      console.log(`[PhotosPicker] Creating picker session for userId=${userId}...`);
      const response = await axios.post(
        `${this.pickerApiBase}/sessions`,
        {},
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

      // Append /autoclose so the popup window closes automatically after selection completes
      if (!pickerUri.includes('/autoclose')) {
        pickerUri = pickerUri.endsWith('/') ? `${pickerUri}autoclose` : `${pickerUri}/autoclose`;
      }

      const expireTimeStr = sessionData.expireTime || sessionData.expiresAt;
      const expiresAt = expireTimeStr ? new Date(expireTimeStr) : new Date(Date.now() + 30 * 60 * 1000);

      // Persist in Prisma
      const dbSession = await prisma.photosPickerSession.create({
        data: {
          pickerSessionId,
          pickerUri,
          userId,
          status: 'CREATED',
          expiresAt
        }
      });

      console.log(`[PhotosPicker] Picker session created cleanly. DB ID=${dbSession.id}, GoogleSessionId=${pickerSessionId}`);

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
        expiresAt: expiresAt.toISOString()
      };
    } catch (err: any) {
      HttpErrorSanitizer.logError('PhotosPickerService.createPickerSession', err);
      const info = HttpErrorSanitizer.extractSanitizedInfo(err);
      throw new Error(`Failed to create Google Photos Picker session: ${info.message}`);
    }
  }

  /**
   * Poll Google Photos Picker session status
   */
  public async getPickerSessionStatus(userId: string, sessionId: string): Promise<PickerSessionResult> {
    const dbSession = await prisma.photosPickerSession.findFirst({
      where: {
        OR: [{ id: sessionId }, { pickerSessionId: sessionId }],
        userId
      }
    });

    if (!dbSession) {
      throw new Error('Picker session not found or does not belong to the user.');
    }

    // Check local expiration
    if (new Date() > dbSession.expiresAt && dbSession.status !== 'SELECTION_COMPLETE') {
      await prisma.photosPickerSession.update({
        where: { id: dbSession.id },
        data: { status: 'EXPIRED' }
      });
      return {
        id: dbSession.id,
        pickerSessionId: dbSession.pickerSessionId,
        pickerUri: dbSession.pickerUri,
        status: 'EXPIRED',
        mediaItemsSet: dbSession.mediaItemsSet,
        selectedCount: dbSession.selectedCount,
        photosCount: dbSession.photosCount,
        videosCount: dbSession.videosCount,
        totalBytes: Number(dbSession.totalBytes),
        expiresAt: dbSession.expiresAt.toISOString()
      };
    }

    if (dbSession.status === 'SELECTION_COMPLETE') {
      return {
        id: dbSession.id,
        pickerSessionId: dbSession.pickerSessionId,
        pickerUri: dbSession.pickerUri,
        status: dbSession.status,
        mediaItemsSet: true,
        selectedCount: dbSession.selectedCount,
        photosCount: dbSession.photosCount,
        videosCount: dbSession.videosCount,
        totalBytes: Number(dbSession.totalBytes),
        expiresAt: dbSession.expiresAt.toISOString()
      };
    }

    // Poll Google Photos Picker API
    const client = await googleClientManager.getAuthenticatedClient(userId, 'photos-source');
    if (!client) {
      throw new Error('Google Photos account is not connected.');
    }

    const tokenRes = await client.getAccessToken();
    const accessToken = tokenRes.token || client.credentials.access_token;
    if (!accessToken) {
      throw new Error('Google Photos access token is missing or expired.');
    }

    try {
      const response = await axios.get(
        `${this.pickerApiBase}/sessions/${dbSession.pickerSessionId}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000
        }
      );

      const sessionData = response.data;
      const mediaItemsSet = !!sessionData.mediaItemsSet;
      const status = mediaItemsSet ? 'SELECTION_COMPLETE' : (dbSession.status === 'CREATED' ? 'WAITING_FOR_SELECTION' : dbSession.status);

      if (status !== dbSession.status || mediaItemsSet !== dbSession.mediaItemsSet) {
        await prisma.photosPickerSession.update({
          where: { id: dbSession.id },
          data: { status, mediaItemsSet }
        });
      }

      return {
        id: dbSession.id,
        pickerSessionId: dbSession.pickerSessionId,
        pickerUri: dbSession.pickerUri,
        status,
        mediaItemsSet,
        selectedCount: dbSession.selectedCount,
        photosCount: dbSession.photosCount,
        videosCount: dbSession.videosCount,
        totalBytes: Number(dbSession.totalBytes),
        expiresAt: dbSession.expiresAt.toISOString()
      };
    } catch (err: any) {
      HttpErrorSanitizer.logError('PhotosPickerService.getPickerSessionStatus', err);
      const info = HttpErrorSanitizer.extractSanitizedInfo(err);
      if (info.status === 404 || info.status === 410) {
        await prisma.photosPickerSession.update({
          where: { id: dbSession.id },
          data: { status: 'EXPIRED' }
        });
        return {
          id: dbSession.id,
          pickerSessionId: dbSession.pickerSessionId,
          pickerUri: dbSession.pickerUri,
          status: 'EXPIRED',
          mediaItemsSet: dbSession.mediaItemsSet,
          selectedCount: dbSession.selectedCount,
          photosCount: dbSession.photosCount,
          videosCount: dbSession.videosCount,
          totalBytes: Number(dbSession.totalBytes),
          expiresAt: dbSession.expiresAt.toISOString()
        };
      }
      throw new Error(`Failed to check Picker session status: ${info.message}`);
    }
  }

  /**
   * Enumerate selected media items from Google Photos Picker API with pagination and persist to SQLite manifest
   */
  public async enumerateAndPersistSelectedItems(
    userId: string,
    sessionId: string,
    manifestId: string
  ): Promise<{ selectedCount: number; photosCount: number; videosCount: number; totalBytes: number }> {
    const dbSession = await prisma.photosPickerSession.findFirst({
      where: {
        OR: [{ id: sessionId }, { pickerSessionId: sessionId }],
        userId
      }
    });

    if (!dbSession) {
      throw new Error('Picker session not found.');
    }

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
            const baseUrl = mediaFile.baseUrl || rawItem.baseUrl || '';

            // Generate deterministic fallback filename if missing
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

          // Persist chunk to SQLite
          await PhotosManifestStorage.saveMediaItemsChunk(manifestId, manifestItems);
          console.log(`[PhotosPicker] Persisted chunk of ${manifestItems.length} items to manifest ${manifestId}. (Total: ${totalSelected})`);
        }
      } catch (err: any) {
        HttpErrorSanitizer.logError('PhotosPickerService.enumerateAndPersistSelectedItems', err);
        const info = HttpErrorSanitizer.extractSanitizedInfo(err);
        throw new Error(`Failed to retrieve selected media items from Google Photos: ${info.message}`);
      }
    } while (pageToken);

    // Update session summary in DB
    await prisma.photosPickerSession.update({
      where: { id: dbSession.id },
      data: {
        status: 'SELECTION_COMPLETE',
        mediaItemsSet: true,
        selectedCount: totalSelected,
        photosCount,
        videosCount,
        totalBytes: BigInt(totalBytes)
      }
    });

    // Cleanup session on Google Photos API server-side
    try {
      await axios.delete(`${this.pickerApiBase}/sessions/${dbSession.pickerSessionId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 5000
      });
      console.log(`[PhotosPicker] Successfully cleaned up Google Picker session ${dbSession.pickerSessionId}`);
    } catch (_) {
      // Non-fatal if session deletion fails
    }

    return {
      selectedCount: totalSelected,
      photosCount,
      videosCount,
      totalBytes
    };
  }
}

export const photosPickerService = new PhotosPickerService();
