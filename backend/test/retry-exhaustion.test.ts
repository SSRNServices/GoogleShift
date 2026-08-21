import { describe, test, expect, vi } from 'vitest';
import { ManifestStorage, ManifestItem } from '../src/utils/ManifestStorage';

describe('Retry Exhaustion & Manifest Persistence', () => {
  test('incrementRetryCount increases item retry count atomically', async () => {
    const manifestId = `test_manifest_${Date.now()}`;
    const item: ManifestItem = {
      id: 'item-retry-1',
      jobId: manifestId,
      sourceId: 'src-1',
      sourceParentId: 'root',
      destParentId: 'dest-root',
      createdDestId: null,
      name: 'retry.avi',
      mimeType: 'video/avi',
      size: 1000,
      originalId: null,
      originalMimeType: null,
      status: 'QUEUED',
      isFolder: false,
      depth: 0,
      retryCount: 0
    };

    await ManifestStorage.saveManifest([item]);

    const count1 = await ManifestStorage.incrementRetryCount(manifestId, item.id);
    expect(count1).toBe(1);

    const count2 = await ManifestStorage.incrementRetryCount(manifestId, item.id);
    expect(count2).toBe(2);

    const updatedItem = await ManifestStorage.getItem(manifestId, item.id);
    expect(updatedItem?.retryCount).toBe(2);

    await ManifestStorage.deleteManifest(manifestId);
  });
});
