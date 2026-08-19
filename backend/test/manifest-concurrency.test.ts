import { describe, it, expect, afterEach } from 'vitest';
import { ManifestStorage, ManifestItem } from '../src/utils/ManifestStorage';

describe('Manifest Concurrency & Persistence Engine', () => {
  const testManifestId = `test_concurrency_${Date.now()}`;

  afterEach(async () => {
    await ManifestStorage.deleteManifest(testManifestId);
  });

  const createSyntheticBatch = (jobId: string, count: number, offset: number = 0): ManifestItem[] => {
    const items: ManifestItem[] = [];
    for (let i = 0; i < count; i++) {
      const idx = offset + i;
      const isFolder = idx % 10 === 0;
      items.push({
        id: `item_${idx}`,
        jobId,
        sourceId: `source_${idx}`,
        sourceParentId: isFolder ? 'root' : `item_${Math.floor(idx / 10) * 10}`,
        destParentId: null,
        createdDestId: null,
        name: isFolder ? `Folder ${idx}` : `File_${idx}.dat`,
        mimeType: isFolder ? 'application/vnd.google-apps.folder' : 'application/octet-stream',
        size: isFolder ? 0 : (idx + 1) * 100,
        originalId: null,
        originalMimeType: null,
        status: 'PENDING',
        isFolder,
        depth: isFolder ? 0 : 1,
        retryCount: 0
      });
    }
    return items;
  };

  it('TEST 1: Single manifest batch writes successfully', async () => {
    const batch = createSyntheticBatch(testManifestId, 50);
    await ManifestStorage.saveManifestChunk(batch);

    const count = await ManifestStorage.countItems(testManifestId);
    expect(count).toBe(50);
  });

  it('TEST 2: Multiple batches submitted concurrently are serialized safely', async () => {
    const batch1 = createSyntheticBatch(testManifestId, 100, 0);
    const batch2 = createSyntheticBatch(testManifestId, 100, 100);
    const batch3 = createSyntheticBatch(testManifestId, 100, 200);

    // Fire 3 calls concurrently without await
    const p1 = ManifestStorage.saveManifestChunk(batch1);
    const p2 = ManifestStorage.saveManifestChunk(batch2);
    const p3 = ManifestStorage.saveManifestChunk(batch3);

    await Promise.all([p1, p2, p3]);

    const totalCount = await ManifestStorage.countItems(testManifestId);
    expect(totalCount).toBe(300);
  });

  it('TEST 3: 50+ batches submitted concurrently do not cause SQLITE_ERROR: cannot start a transaction within a transaction', async () => {
    const promises: Promise<void>[] = [];
    const totalBatches = 50;
    const itemsPerBatch = 50;

    for (let i = 0; i < totalBatches; i++) {
      const batch = createSyntheticBatch(testManifestId, itemsPerBatch, i * itemsPerBatch);
      promises.push(ManifestStorage.saveManifestChunk(batch));
    }

    await expect(Promise.all(promises)).resolves.not.toThrow();

    const count = await ManifestStorage.countItems(testManifestId);
    expect(count).toBe(totalBatches * itemsPerBatch);
  });

  it('TEST 4 & 5: Failed batch triggers rollback and does not poison subsequent transactions', async () => {
    const validBatch1 = createSyntheticBatch(testManifestId, 20, 0);
    await ManifestStorage.saveManifestChunk(validBatch1);

    // Malformed batch with jobId=null to force NOT NULL constraint error inside transaction
    const invalidBatch: any = [
      {
        id: 'invalid_item',
        jobId: null
      }
    ];

    await expect(ManifestStorage.saveManifestChunk(invalidBatch)).rejects.toThrow();

    // Verify database connection is clean and able to process subsequent valid writes
    const validBatch2 = createSyntheticBatch(testManifestId, 20, 100);
    await expect(ManifestStorage.saveManifestChunk(validBatch2)).resolves.not.toThrow();

    const count = await ManifestStorage.countItems(testManifestId);
    expect(count).toBe(40);
  });

  it('TEST 8: Duplicate batch retry is idempotent and prevents duplicate rows', async () => {
    const batch = createSyntheticBatch(testManifestId, 100, 0);

    // Save batch first time
    await ManifestStorage.saveManifestChunk(batch);
    const countFirst = await ManifestStorage.countItems(testManifestId);
    expect(countFirst).toBe(100);

    // Re-save exact same batch (simulating retry or duplicate delivery)
    await ManifestStorage.saveManifestChunk(batch);
    const countSecond = await ManifestStorage.countItems(testManifestId);
    expect(countSecond).toBe(100);
  });

  it('TEST 11: Large discovery workload simulation (30,000 manifest items across 30 batches)', async () => {
    const largeManifestId = `test_large_${Date.now()}`;
    const totalItems = 30000;
    const batchSize = 1000;
    const numBatches = totalItems / batchSize;

    console.log(`Starting synthetic large discovery benchmark: ${totalItems} items in ${numBatches} batches...`);
    const startTime = Date.now();

    const batchPromises: Promise<void>[] = [];
    for (let b = 0; b < numBatches; b++) {
      const chunk = createSyntheticBatch(largeManifestId, batchSize, b * batchSize);
      batchPromises.push(ManifestStorage.saveManifestChunk(chunk));
    }

    await Promise.all(batchPromises);
    const elapsed = Date.now() - startTime;
    console.log(`Successfully persisted ${totalItems} items across ${numBatches} batches in ${elapsed}ms`);

    const stats = await ManifestStorage.getSummaryStats(largeManifestId);
    const count = await ManifestStorage.countItems(largeManifestId);

    expect(count).toBe(totalItems);
    expect(stats.totalFolders + stats.totalFiles).toBe(totalItems);

    await ManifestStorage.deleteManifest(largeManifestId);
  }, 30000);
});
