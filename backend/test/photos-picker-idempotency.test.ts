import { describe, it, expect, beforeEach, vi } from 'vitest';
import { photosPickerService } from '../src/services/PhotosPickerService';
import { photosMigrationService } from '../src/services/PhotosMigrationService';
import { prisma } from '../src/utils/database';
import { PhotosManifestStorage } from '../src/utils/PhotosManifestStorage';

describe('Google Photos Picker Idempotency & Session Lifecycle Tests', () => {
  const testUserId = 'user_idempotency_test';
  const testSessionId = `picker_session_test_${Date.now()}`;
  const testManifestId = `manifest_idempotency_${Date.now()}`;

  beforeEach(async () => {
    // Ensure test user exists in database
    await prisma.user.upsert({
      where: { id: testUserId },
      update: { status: 'ACTIVE' },
      create: {
        id: testUserId,
        email: 'test_idempotency@example.com',
        name: 'Test Idempotency User',
        role: 'USER',
        status: 'ACTIVE'
      }
    });

    // Create a completed PhotosPickerSession with manifestId
    await prisma.photosPickerSession.upsert({
      where: { id: testSessionId },
      update: {
        status: 'SELECTION_COMPLETE',
        mediaItemsSet: true,
        manifestId: testManifestId,
        selectedCount: 5,
        photosCount: 3,
        videosCount: 2,
        totalBytes: BigInt(10485760)
      },
      create: {
        id: testSessionId,
        pickerSessionId: testSessionId,
        pickerUri: 'https://photospicker.googleapis.com/v1/sessions/test',
        userId: testUserId,
        status: 'SELECTION_COMPLETE',
        mediaItemsSet: true,
        manifestId: testManifestId,
        selectedCount: 5,
        photosCount: 3,
        videosCount: 2,
        totalBytes: BigInt(10485760),
        expiresAt: new Date(Date.now() + 3600 * 1000)
      }
    });

    // Save test items in SQLite manifest
    await PhotosManifestStorage.saveMediaItemsChunk(testManifestId, [
      {
        id: `item_1_${Date.now()}`,
        jobId: testManifestId,
        sourceMediaId: 'media_1',
        sourceFilename: 'photo1.jpg',
        mimeType: 'image/jpeg',
        size: 2048576,
        creationTime: new Date().toISOString(),
        mediaType: 'PHOTO',
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
    ]);
  });

  it('should return cached summary and manifestId without calling Google API when session is already SELECTION_COMPLETE or CLEANED_UP', async () => {
    const summary = await photosPickerService.enumerateAndPersistSelectedItems(testUserId, testSessionId, 'different-manifest-id');
    
    expect(summary.selectedCount).toBeGreaterThanOrEqual(1);
    expect(summary.manifestId).toBe(testManifestId);
  });

  it('should reuse existing manifest in createPhotosJob when picker session is already completed', async () => {
    // Create source and dest accounts for user
    await prisma.oAuthAccount.deleteMany({
      where: { userId: testUserId }
    });

    await prisma.oAuthAccount.create({
      data: {
        userId: testUserId,
        provider: 'google-photos-source',
        providerAccountId: 'photos_source_acc_123',
        email: 'photos_source@example.com',
        scopes: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly'
      }
    });

    await prisma.oAuthAccount.create({
      data: {
        userId: testUserId,
        provider: 'google-destination',
        providerAccountId: 'drive_dest_acc_123',
        email: 'drive_dest@example.com',
        scopes: 'https://www.googleapis.com/auth/drive'
      }
    });

    const jobResult = await photosMigrationService.createPhotosJob({
      userId: testUserId,
      pickerSessionId: testSessionId,
      destinationDriveFolderId: 'root',
      organization: 'FLAT'
    });

    expect(jobResult.manifestId).toBe(testManifestId);
    expect(jobResult.selectedCount).toBeGreaterThanOrEqual(1);
  });
});
