import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PhotosManifestStorage, PhotosManifestItem, PhotosAlbumItem } from '../src/utils/PhotosManifestStorage';
import { PhotosRateLimiter } from '../src/transfer/PhotosRateLimiter';

describe('Google Photos Migration Engine Unit & Integration Tests', () => {
  const testManifestId = `test_photos_manifest_${Date.now()}`;

  afterEach(async () => {
    await PhotosManifestStorage.closeDb(testManifestId);
  });

  describe('PhotosManifestStorage', () => {
    it('should save and retrieve media items correctly', async () => {
      const items: PhotosManifestItem[] = [
        {
          id: 'photo_1',
          jobId: testManifestId,
          sourceMediaId: 'src_p1',
          sourceFilename: 'vacation.jpg',
          mimeType: 'image/jpeg',
          size: 2048000,
          creationTime: '2025-01-01T10:00:00Z',
          mediaType: 'PHOTO',
          albumIds: ['album_1'],
          destAlbumIds: [],
          destMediaId: null,
          checksum: null,
          status: 'PENDING',
          retryCount: 0,
          error: null,
          lastAttemptAt: null,
          verifiedAt: null,
          createdAt: Date.now()
        },
        {
          id: 'video_1',
          jobId: testManifestId,
          sourceMediaId: 'src_v1',
          sourceFilename: 'family.mp4',
          mimeType: 'video/mp4',
          size: 52428800,
          creationTime: '2025-01-02T12:00:00Z',
          mediaType: 'VIDEO',
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
        }
      ];

      await PhotosManifestStorage.saveMediaItemsChunk(testManifestId, items);

      const count = await PhotosManifestStorage.countItems(testManifestId);
      expect(count).toBe(2);

      const photoCount = await PhotosManifestStorage.countItems(testManifestId, { mediaType: 'PHOTO' });
      expect(photoCount).toBe(1);

      const videoCount = await PhotosManifestStorage.countItems(testManifestId, { mediaType: 'VIDEO' });
      expect(videoCount).toBe(1);
    });

    it('should calculate summary stats correctly', async () => {
      const stats = await PhotosManifestStorage.getSummaryStats(testManifestId);
      expect(stats.totalItems).toBe(2);
      expect(stats.photosCount).toBe(1);
      expect(stats.videosCount).toBe(1);
      expect(stats.completedItems).toBe(0);
      expect(stats.pendingItems).toBe(2);
    });

    it('should update item status, destMediaId, and checksum safely', async () => {
      await PhotosManifestStorage.updateItemStatus(
        testManifestId,
        'photo_1',
        'SUCCESS',
        'dest_media_123',
        null,
        'sha256_checksum_abc'
      );

      const stats = await PhotosManifestStorage.getSummaryStats(testManifestId);
      expect(stats.completedItems).toBe(1);
      expect(stats.pendingItems).toBe(1);
    });

    it('should handle album persistence and status updates', async () => {
      const albums: PhotosAlbumItem[] = [
        {
          id: 'album_1',
          jobId: testManifestId,
          sourceAlbumId: 'src_alb_1',
          title: 'Summer Trip 2025',
          mediaItemsCount: 15,
          destAlbumId: null,
          status: 'PENDING',
          error: null
        }
      ];

      await PhotosManifestStorage.saveAlbums(testManifestId, albums);
      const savedAlbums = await PhotosManifestStorage.getAlbums(testManifestId);
      expect(savedAlbums.length).toBe(1);
      expect(savedAlbums[0].title).toBe('Summer Trip 2025');

      await PhotosManifestStorage.updateAlbumStatus(testManifestId, 'src_alb_1', 'CREATED', 'dest_alb_999');
      const updatedAlbums = await PhotosManifestStorage.getAlbums(testManifestId);
      expect(updatedAlbums[0].status).toBe('CREATED');
      expect(updatedAlbums[0].destAlbumId).toBe('dest_alb_999');
    });
  });

  describe('PhotosRateLimiter', () => {
    it('should downscale concurrency when rate limit 429 is reported', () => {
      const limiter = new PhotosRateLimiter(6, 1, 10);
      expect(limiter.getConcurrency()).toBe(6);

      limiter.reportRateLimit();
      expect(limiter.getConcurrency()).toBeLessThan(6);
    });

    it('should set backoff delay on 429 rate limit', () => {
      const limiter = new PhotosRateLimiter(4, 1, 10);
      const delayMs = limiter.reportRateLimit(5);
      expect(delayMs).toBe(5000);
    });
  });
});
