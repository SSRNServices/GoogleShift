import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { ManifestStorage, ManifestItem } from '../src/utils/ManifestStorage';
import { MigrationStateManager } from '../src/services/MigrationStateManager';

describe('Progress State Synchronization & Telemetry', () => {
  const manifestId = `test_sync_manifest_${Date.now()}`;
  const jobId = `test_sync_job_${Date.now()}`;

  beforeEach(async () => {
    const items: ManifestItem[] = [
      {
        id: 'file-1',
        jobId: manifestId,
        sourceId: 'src-1',
        sourceParentId: 'root',
        destParentId: 'dest-root',
        createdDestId: null,
        name: 'test1.pdf',
        mimeType: 'application/pdf',
        size: 1000,
        originalId: null,
        originalMimeType: null,
        status: 'QUEUED',
        isFolder: false,
        depth: 0,
        retryCount: 0
      },
      {
        id: 'file-2',
        jobId: manifestId,
        sourceId: 'src-2',
        sourceParentId: 'root',
        destParentId: 'dest-root',
        createdDestId: null,
        name: 'test2.zip',
        mimeType: 'application/zip',
        size: 2000,
        originalId: null,
        originalMimeType: null,
        status: 'QUEUED',
        isFolder: false,
        depth: 0,
        retryCount: 0
      }
    ];

    await ManifestStorage.saveManifest(items);
  });

  afterEach(async () => {
    await ManifestStorage.deleteManifest(manifestId);
  });

  test('ManifestStorage.getSummaryStats returns accurate counts and byte totals', async () => {
    const stats0 = await ManifestStorage.getSummaryStats(manifestId);
    expect(stats0.totalFiles).toBe(2);
    expect(stats0.completedFiles).toBe(0);
    expect(stats0.failedFiles).toBe(0);
    expect(stats0.totalBytes).toBe(3000);
    expect(stats0.transferredBytes).toBe(0);

    // Commit file 1 SUCCESS
    await ManifestStorage.updateItemStatus(manifestId, 'file-1', 'SUCCESS');

    const stats1 = await ManifestStorage.getSummaryStats(manifestId);
    expect(stats1.completedFiles).toBe(1);
    expect(stats1.transferredBytes).toBe(1000);

    // Commit file 2 FAILED
    await ManifestStorage.updateItemStatus(manifestId, 'file-2', 'FAILED');

    const stats2 = await ManifestStorage.getSummaryStats(manifestId);
    expect(stats2.completedFiles).toBe(1);
    expect(stats2.failedFiles).toBe(1);
    expect(stats2.transferredBytes).toBe(1000);
  });

  test('MigrationStateManager increments sequenceNumber on state changes', async () => {
    const stateManager = new MigrationStateManager(jobId, manifestId);
    expect(stateManager.sequenceNumber).toBe(0);

    const dummyItem: ManifestItem = {
      id: 'file-1',
      jobId: manifestId,
      sourceId: 'src-1',
      sourceParentId: 'root',
      destParentId: 'dest-root',
      createdDestId: null,
      name: 'test1.pdf',
      mimeType: 'application/pdf',
      size: 1000,
      originalId: null,
      originalMimeType: null,
      status: 'QUEUED',
      isFolder: false,
      depth: 0,
      retryCount: 0
    };

    await stateManager.commitSuccess(dummyItem);
    expect(stateManager.sequenceNumber).toBe(1);

    await stateManager.updateState('file-2', 'FAILED');
    expect(stateManager.sequenceNumber).toBe(2);

    stateManager.stopProgressInterval();
  });

  test('resetAllStatus preserves existing SUCCESS items during resume', async () => {
    await ManifestStorage.updateItemStatus(manifestId, 'file-1', 'SUCCESS');
    await ManifestStorage.updateItemStatus(manifestId, 'file-2', 'UPLOADING');

    await ManifestStorage.resetAllStatus(manifestId, 'PENDING');

    const item1 = await ManifestStorage.getItem(manifestId, 'file-1');
    const item2 = await ManifestStorage.getItem(manifestId, 'file-2');

    expect(item1?.status).toBe('SUCCESS'); // Preserved!
    expect(item2?.status).toBe('PENDING'); // Reset!
  });
});
