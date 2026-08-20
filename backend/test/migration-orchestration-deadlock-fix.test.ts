import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ManifestStorage, ManifestItem } from '../src/utils/ManifestStorage';
import { MigrationReconciler } from '../src/services/MigrationReconciler';
import { FolderDAG } from '../src/transfer/FolderDAG';

describe('Migration Orchestration & Deadlock Fix Suite', () => {
  const manifestId = `test_deadlock_manifest_${Date.now()}`;

  it('TEST 1: Exact 4-folder deadlock scenario recovery via MigrationReconciler', async () => {
    // 5 folders: 1 root parent + 2 level-1 folders (YT, Shorts) + 2 level-2 folders (800 Reels, 50+)
    // 319 files (all SUCCESS)
    const mockItems: ManifestItem[] = [
      // Completed root folder
      {
        id: 'folder_root_1',
        jobId: manifestId,
        sourceId: 'src_root_1',
        sourceParentId: 'root',
        destParentId: 'dest_root_0',
        createdDestId: 'dest_root_1',
        name: 'Root Folder',
        mimeType: 'application/vnd.google-apps.folder',
        size: 0,
        originalId: null,
        originalMimeType: null,
        status: 'SUCCESS',
        isFolder: true,
        depth: 0,
        retryCount: 0
      },
      // Level 1 folders left QUEUED
      {
        id: 'folder_yt_2',
        jobId: manifestId,
        sourceId: 'src_yt_2',
        sourceParentId: 'src_root_1',
        destParentId: 'dest_root_1',
        createdDestId: null,
        name: 'YT',
        mimeType: 'application/vnd.google-apps.folder',
        size: 0,
        originalId: null,
        originalMimeType: null,
        status: 'QUEUED',
        isFolder: true,
        depth: 1,
        retryCount: 0
      },
      {
        id: 'folder_shorts_3',
        jobId: manifestId,
        sourceId: 'src_shorts_3',
        sourceParentId: 'src_root_1',
        destParentId: 'dest_root_1',
        createdDestId: null,
        name: 'Shorts',
        mimeType: 'application/vnd.google-apps.folder',
        size: 0,
        originalId: null,
        originalMimeType: null,
        status: 'QUEUED',
        isFolder: true,
        depth: 1,
        retryCount: 0
      },
      // Level 2 folders left PENDING
      {
        id: 'folder_reels_4',
        jobId: manifestId,
        sourceId: 'src_reels_4',
        sourceParentId: 'src_yt_2',
        destParentId: null,
        createdDestId: null,
        name: '800 Reels',
        mimeType: 'application/vnd.google-apps.folder',
        size: 0,
        originalId: null,
        originalMimeType: null,
        status: 'PENDING',
        isFolder: true,
        depth: 2,
        retryCount: 0
      },
      {
        id: 'folder_50_5',
        jobId: manifestId,
        sourceId: 'src_50_5',
        sourceParentId: 'src_yt_2',
        destParentId: null,
        createdDestId: null,
        name: '50+',
        mimeType: 'application/vnd.google-apps.folder',
        size: 0,
        originalId: null,
        originalMimeType: null,
        status: 'PENDING',
        isFolder: true,
        depth: 2,
        retryCount: 0
      }
    ];

    // Add 319 completed files
    for (let i = 1; i <= 319; i++) {
      mockItems.push({
        id: `file_${i}`,
        jobId: manifestId,
        sourceId: `src_file_${i}`,
        sourceParentId: 'src_yt_2',
        destParentId: 'dest_yt_2',
        createdDestId: `dest_file_${i}`,
        name: `File ${i}.mp4`,
        mimeType: 'video/mp4',
        size: 1000000,
        originalId: null,
        originalMimeType: null,
        status: 'SUCCESS',
        isFolder: false,
        depth: 2,
        retryCount: 0
      });
    }

    // Save manifest items to SQLite
    await ManifestStorage.saveManifest(mockItems);

    // Initial check: 4 unresolved folders remain
    const initialUnresolved = await ManifestStorage.getUnresolvedItems(manifestId, 100);
    expect(initialUnresolved.length).toBe(4);

    // Mock Google Drive destination search returning destination folder IDs
    const mockDestDrive: any = {
      files: {
        list: async (params: any) => {
          const query = params.q || '';
          if (query.includes('YT')) return { data: { files: [{ id: 'dest_yt_2' }] } };
          if (query.includes('Shorts')) return { data: { files: [{ id: 'dest_shorts_3' }] } };
          if (query.includes('800 Reels')) return { data: { files: [{ id: 'dest_reels_4' }] } };
          if (query.includes('50+')) return { data: { files: [{ id: 'dest_50_5' }] } };
          return { data: { files: [] } };
        }
      }
    };

    // Run MigrationReconciler
    const report = await MigrationReconciler.reconcileSchedulerState(manifestId, mockDestDrive, 'dest_root_0');

    expect(report.foldersRecovered).toBe(4);
    expect(report.itemsResolved).toBe(4);

    // Verify all folders are now resolved as SUCCESS in SQLite DB
    const finalUnresolved = await ManifestStorage.getUnresolvedItems(manifestId, 100);
    expect(finalUnresolved.length).toBe(0);

    const summary = await ManifestStorage.getSummaryStats(manifestId);
    expect(summary.completedFiles).toBe(319);
    expect(summary.totalFolders).toBe(5);
  });

  it('TEST 2: FolderDAG rebuildFromDB re-syncs in-memory nodes from SQLite DB manifest cleanly', async () => {
    const dag = new FolderDAG('root_dest');
    const folders: ManifestItem[] = [
      {
        id: 'f1',
        jobId: 'm1',
        sourceId: 's1',
        sourceParentId: 'root',
        destParentId: 'root_dest',
        createdDestId: 'd1',
        name: 'Folder 1',
        mimeType: 'application/vnd.google-apps.folder',
        size: 0,
        originalId: null,
        originalMimeType: null,
        status: 'SUCCESS',
        isFolder: true,
        depth: 0,
        retryCount: 0
      },
      {
        id: 'f2',
        jobId: 'm1',
        sourceId: 's2',
        sourceParentId: 's1',
        destParentId: 'd1',
        createdDestId: null,
        name: 'Folder 2',
        mimeType: 'application/vnd.google-apps.folder',
        size: 0,
        originalId: null,
        originalMimeType: null,
        status: 'QUEUED',
        isFolder: true,
        depth: 1,
        retryCount: 0
      }
    ];

    dag.build(folders);
    expect(dag.getDiagnostics().nodes).toBe(2);

    // Update status in folder array and rebuild
    folders[1].status = 'SUCCESS';
    folders[1].createdDestId = 'd2';
    dag.rebuildFromDB(folders);

    expect(dag.isComplete()).toBe(true);
  });
});
