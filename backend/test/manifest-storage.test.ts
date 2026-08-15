import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ManifestStorage, ManifestItem } from '../src/utils/ManifestStorage';

describe('ManifestStorage SQLite Engine', () => {
  const testManifestId = `test_manifest_${Date.now()}`;

  afterEach(async () => {
    await ManifestStorage.deleteManifest(testManifestId);
  });

  it('should save chunks of folders and files to local SQLite database', async () => {
    const items: ManifestItem[] = [
      {
        id: 'folder1',
        jobId: testManifestId,
        sourceId: 'folder1',
        sourceParentId: 'root',
        destParentId: null,
        createdDestId: null,
        name: 'Folder 1',
        mimeType: 'application/vnd.google-apps.folder',
        size: 0,
        originalId: null,
        originalMimeType: null,
        status: 'PENDING',
        isFolder: true,
        depth: 0,
        retryCount: 0
      },
      {
        id: 'file1',
        jobId: testManifestId,
        sourceId: 'file1',
        sourceParentId: 'folder1',
        destParentId: null,
        createdDestId: null,
        name: 'File 1.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        originalId: null,
        originalMimeType: null,
        status: 'PENDING',
        isFolder: false,
        depth: 1,
        retryCount: 0
      }
    ];

    await ManifestStorage.saveManifestChunk(items);

    const hasManifest = await ManifestStorage.hasManifest(testManifestId);
    expect(hasManifest).toBe(true);

    const totalCount = await ManifestStorage.countItems(testManifestId);
    expect(totalCount).toBe(2);

    const folderCount = await ManifestStorage.countItems(testManifestId, { isFolder: true });
    expect(folderCount).toBe(1);

    const fileCount = await ManifestStorage.countItems(testManifestId, { isFolder: false });
    expect(fileCount).toBe(1);
  });

  it('should perform depth-ordered folder queries and parent update transitions', async () => {
    const items: ManifestItem[] = [
      {
        id: 'f_depth_1',
        jobId: testManifestId,
        sourceId: 'f_depth_1',
        sourceParentId: 'root',
        destParentId: null,
        createdDestId: null,
        name: 'Depth 1 Folder',
        mimeType: 'application/vnd.google-apps.folder',
        size: 0,
        originalId: null,
        originalMimeType: null,
        status: 'PENDING',
        isFolder: true,
        depth: 1,
        retryCount: 0
      },
      {
        id: 'f_depth_0',
        jobId: testManifestId,
        sourceId: 'f_depth_0',
        sourceParentId: 'root',
        destParentId: null,
        createdDestId: null,
        name: 'Depth 0 Folder',
        mimeType: 'application/vnd.google-apps.folder',
        size: 0,
        originalId: null,
        originalMimeType: null,
        status: 'PENDING',
        isFolder: true,
        depth: 0,
        retryCount: 0
      }
    ];

    await ManifestStorage.saveManifestChunk(items);

    const pendingFolders = await ManifestStorage.getPendingFoldersByDepth(testManifestId);
    expect(pendingFolders.length).toBe(2);
    expect(pendingFolders[0].id).toBe('f_depth_0');
    expect(pendingFolders[1].id).toBe('f_depth_1');

    await ManifestStorage.updateDestParentId(testManifestId, 'root', 'dest_root_id');
    const children = await ManifestStorage.getChildren(testManifestId, 'root');
    expect(children.length).toBe(2);
    expect(children[0].destParentId).toBe('dest_root_id');
    expect(children[1].destParentId).toBe('dest_root_id');
  });

  it('should handle status guards and prevent backwards status transitions', async () => {
    const item: ManifestItem = {
      id: 'file_guard',
      jobId: testManifestId,
      sourceId: 'file_guard',
      sourceParentId: 'root',
      destParentId: 'dest_root',
      createdDestId: null,
      name: 'Guard File.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 2048,
      originalId: null,
      originalMimeType: null,
      status: 'QUEUED',
      isFolder: false,
      depth: 0,
      retryCount: 0
    };

    await ManifestStorage.saveManifestChunk([item]);

    await ManifestStorage.updateItemStatus(testManifestId, 'file_guard', 'SUCCESS');
    let dbItem = await ManifestStorage.getItem(testManifestId, 'file_guard');
    expect(dbItem?.status).toBe('SUCCESS');

    // Attempt invalid backwards transition
    await ManifestStorage.updateItemStatus(testManifestId, 'file_guard', 'QUEUED');
    dbItem = await ManifestStorage.getItem(testManifestId, 'file_guard');
    expect(dbItem?.status).toBe('SUCCESS');
  });

  it('should handle large volume (2,000 items) batch writes quickly without errors', async () => {
    const largeChunk: ManifestItem[] = [];
    for (let i = 0; i < 2000; i++) {
      largeChunk.push({
        id: `item_${i}`,
        jobId: testManifestId,
        sourceId: `source_${i}`,
        sourceParentId: i === 0 ? 'root' : `source_${Math.floor(i / 10)}`,
        destParentId: null,
        createdDestId: null,
        name: `Item ${i}`,
        mimeType: i % 5 === 0 ? 'application/vnd.google-apps.folder' : 'application/octet-stream',
        size: i % 5 === 0 ? 0 : 5000,
        originalId: null,
        originalMimeType: null,
        status: 'PENDING',
        isFolder: i % 5 === 0,
        depth: Math.floor(i / 100),
        retryCount: 0
      });
    }

    const startTime = Date.now();
    await ManifestStorage.saveManifest(largeChunk);
    const duration = Date.now() - startTime;

    console.log(`Saved 2,000 items in ${duration}ms`);
    expect(duration).toBeLessThan(5000);

    const stats = await ManifestStorage.getSummaryStats(testManifestId);
    expect(stats.totalFolders).toBe(400);
    expect(stats.totalFiles).toBe(1600);
    expect(stats.totalBytes).toBe(1600 * 5000);
  });
});
