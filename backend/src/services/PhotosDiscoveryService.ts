import { googleClientManager } from '../auth/google.client';
import { GooglePhotosProvider, PhotosMediaItem } from '../providers/GooglePhotosProvider';
import { PhotosManifestStorage, PhotosManifestItem, PhotosAlbumItem } from '../utils/PhotosManifestStorage';
import { prisma, logJobEvent } from '../utils/database';

export class PhotosDiscoveryService {
  public async discoverPhotos(
    jobId: string,
    userId: string,
    manifestId: string
  ): Promise<{
    totalItems: number;
    photosCount: number;
    videosCount: number;
    albumsCount: number;
    totalBytes: number;
  }> {
    console.log(`[PhotosDiscovery] Starting discovery for jobId=${jobId}, manifestId=${manifestId}, userId=${userId}`);

    const client = await googleClientManager.getAuthenticatedClient(userId, 'photos-source');
    if (!client) {
      throw new Error('Source Google Photos account is not authenticated or token expired.');
    }

    const provider = new GooglePhotosProvider(client);

    await prisma.discoveryJob.upsert({
      where: { id: jobId },
      update: { state: 'DISCOVERING', startedAt: new Date() },
      create: {
        id: jobId,
        ownerId: userId,
        manifestId,
        state: 'DISCOVERING',
        startedAt: new Date()
      }
    });

    let totalItems = 0;
    let photosCount = 0;
    let videosCount = 0;
    let totalBytes = 0;
    let albumsCount = 0;

    // 1. Discover Albums & Album Membership
    const albumMediaMap = new Map<string, string[]>(); // sourceMediaId -> sourceAlbumId[]
    try {
      let albumPageToken: string | undefined = undefined;
      const discoveredAlbums: PhotosAlbumItem[] = [];

      do {
        const albumRes = await provider.listAlbums(albumPageToken);
        const albums = albumRes.albums || [];
        albumPageToken = albumRes.nextPageToken;

        for (const alb of albums) {
          discoveredAlbums.push({
            id: `album_${alb.id}`,
            jobId,
            sourceAlbumId: alb.id,
            title: alb.title || 'Untitled Album',
            mediaItemsCount: Number(alb.mediaItemsCount || 0),
            destAlbumId: null,
            status: 'PENDING',
            error: null
          });

          // Fetch media item IDs in this album to build album membership map
          try {
            let memberPageToken: string | undefined = undefined;
            do {
              const memberRes = await provider.listAlbumMediaItems(alb.id, memberPageToken);
              memberPageToken = memberRes.nextPageToken;
              for (const m of memberRes.mediaItems || []) {
                const existing = albumMediaMap.get(m.id) || [];
                if (!existing.includes(alb.id)) {
                  existing.push(alb.id);
                  albumMediaMap.set(m.id, existing);
                }
              }
            } while (memberPageToken);
          } catch (mErr: any) {
            console.warn(`[PhotosDiscovery] Could not list media items for album ${alb.id}: ${mErr.message}`);
          }
        }
      } while (albumPageToken);

      if (discoveredAlbums.length > 0) {
        albumsCount = discoveredAlbums.length;
        await PhotosManifestStorage.saveAlbums(manifestId, discoveredAlbums);
        console.log(`[PhotosDiscovery] Saved ${discoveredAlbums.length} albums to manifest.`);
      }
    } catch (albErr: any) {
      console.warn(`[PhotosDiscovery] Non-fatal album discovery warning: ${albErr.message}`);
    }

    // 2. Discover Media Items (Photos and Videos) with Paged Checkpoints
    let pageToken: string | undefined = undefined;
    let pageIndex = 0;

    do {
      pageIndex++;
      let attempt = 1;
      const maxAttempts = 5;
      let mediaRes: { mediaItems: PhotosMediaItem[]; nextPageToken?: string } | null = null;

      while (attempt <= maxAttempts) {
        try {
          mediaRes = await provider.listMediaItems(pageToken);
          break;
        } catch (err: any) {
          const is429 = err.response?.status === 429 || err.message?.includes('429');
          if (is429 && attempt < maxAttempts) {
            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
            console.warn(`[PhotosDiscovery] 429 Rate Limit on page ${pageIndex}, attempt ${attempt}. Waiting ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            attempt++;
          } else {
            throw err;
          }
        }
      }

      if (!mediaRes) break;

      const rawItems = mediaRes.mediaItems || [];
      pageToken = mediaRes.nextPageToken;

      const manifestItems: PhotosManifestItem[] = rawItems.map(item => {
        const isVideo = (item.mimeType && item.mimeType.startsWith('video/')) || Boolean(item.mediaMetadata?.video);
        const mediaType: 'PHOTO' | 'VIDEO' = isVideo ? 'VIDEO' : 'PHOTO';
        const albumIds = albumMediaMap.get(item.id) || [];

        // Estimate size if not explicitly returned by API (e.g. 5MB default for photo, 50MB for video)
        const sizeEst = isVideo ? 50 * 1024 * 1024 : 5 * 1024 * 1024;

        if (isVideo) videosCount++;
        else photosCount++;
        totalItems++;
        totalBytes += sizeEst;

        return {
          id: `photos_${item.id}`,
          jobId,
          sourceMediaId: item.id,
          sourceFilename: item.filename || `media_${item.id}.${isVideo ? 'mp4' : 'jpg'}`,
          mimeType: item.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
          size: sizeEst,
          creationTime: item.mediaMetadata?.creationTime || null,
          mediaType,
          albumIds,
          destAlbumIds: [],
          destMediaId: null,
          checksum: null,
          status: 'PENDING',
          retryCount: 0,
          error: null,
          lastAttemptAt: null,
          verifiedAt: null,
          createdAt: Date.now()
        };
      });

      if (manifestItems.length > 0) {
        await PhotosManifestStorage.saveMediaItemsChunk(manifestId, manifestItems);
      }

      // Checkpoint discovery state to DB
      await prisma.discoveryJob.update({
        where: { id: jobId },
        data: {
          filesFound: totalItems,
          bytesFound: BigInt(totalBytes),
          checkpointData: JSON.stringify({ pageIndex, pageToken: pageToken || null }),
          lastHeartbeat: new Date()
        }
      });

      console.log(`[PhotosDiscovery] Page ${pageIndex} complete: ${manifestItems.length} items persisted. Total: ${totalItems}`);
    } while (pageToken);

    // Finalize Discovery State
    await prisma.discoveryJob.update({
      where: { id: jobId },
      data: {
        state: 'COMPLETED',
        completedAt: new Date(),
        filesFound: totalItems,
        bytesFound: BigInt(totalBytes)
      }
    });

    // Update MigrationSession discoveryStatus
    const discoveryJobRecord = await prisma.discoveryJob.findUnique({ where: { id: jobId } });
    if (discoveryJobRecord?.sessionId) {
      await prisma.migrationSession.update({
        where: { id: discoveryJobRecord.sessionId },
        data: {
          discoveryStatus: 'COMPLETED',
          statistics: {
            totalItems,
            photosCount,
            videosCount,
            albumsCount,
            totalBytes
          }
        }
      });
    }

    console.log(`[PhotosDiscovery] Discovery complete for jobId=${jobId}: ${photosCount} photos, ${videosCount} videos, ${albumsCount} albums.`);

    return {
      totalItems,
      photosCount,
      videosCount,
      albumsCount,
      totalBytes
    };
  }
}

export const photosDiscoveryService = new PhotosDiscoveryService();
