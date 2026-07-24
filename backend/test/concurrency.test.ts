import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MigrationStateManager } from '../src/services/MigrationStateManager';
import { getDb } from '../src/utils/database';
import { ManifestStorage } from '../src/utils/ManifestStorage';

describe('Database Concurrency and State Manager', () => {
  let db: any;
  let stateManager: MigrationStateManager;
  const JOB_ID = 'concurrency_test_job';

  beforeEach(async () => {
    db = await getDb();
    await db.run('DELETE FROM migration_manifest WHERE jobId = ?', [JOB_ID]);
    await db.run('DELETE FROM migration_jobs WHERE jobId = ?', [JOB_ID]);
    
    // Insert mock job
    await db.run('INSERT INTO migration_jobs (jobId, status) VALUES (?, ?)', [JOB_ID, 'running']);
    
    // Create 100 folders
    for (let i = 0; i < 100; i++) {
       await ManifestStorage.insertItem({
          id: `folder_${i}`,
          jobId: JOB_ID,
          sourceId: `folder_${i}`,
          sourceParentId: 'root',
          destParentId: 'root',
          createdDestId: null,
          name: `Folder ${i}`,
          mimeType: 'application/vnd.google-apps.folder',
          size: 0,
          originalId: null,
          originalMimeType: null,
          status: 'PENDING',
          isFolder: true,
          depth: 0,
          retryCount: 0
       });
    }

    stateManager = new MigrationStateManager(JOB_ID);
  });

  afterEach(() => {
     vi.restoreAllMocks();
  });

  it('should serialize 100 concurrent folder success commits without SQLITE_BUSY', async () => {
    const promises: Promise<void>[] = [];
    
    // Fire 100 commits concurrently!
    for (let i = 0; i < 100; i++) {
       promises.push(stateManager.commitFolderSuccess(`folder_${i}`, `dest_${i}`));
    }
    
    await Promise.all(promises);
    
    // Verify they all succeeded
    const count = await db.get('SELECT COUNT(*) as count FROM migration_manifest WHERE jobId = ? AND status = ?', [JOB_ID, 'SUCCESS']);
    expect(count.count).toBe(100);
    
    // Verify pendingDBWrites is 0
    expect(stateManager.getPendingWriteCount()).toBe(0);
  });
});
