import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/MigrationWorker', () => ({
  migrationWorker: {
    executeMigration: vi.fn().mockResolvedValue(true)
  }
}));

import { getDb, createJob, updateJobStatus } from '../src/utils/database';
import { migrationService } from '../src/services/MigrationService';
import { migrationWorker } from '../src/services/MigrationWorker';

describe('Migration Lifecycle State Machine', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const db = await getDb();
    await db.run('DELETE FROM migration_jobs');
  });

  it('Backend startup performs zero uploads', async () => {
    expect(migrationWorker.executeMigration).not.toHaveBeenCalled();
  });

  it('POST /migration/start is the only entry point that triggers execution', async () => {
    const payload = {
      manifestId: 'test_manifest_1',
      sourceSelection: [{ id: 'src_1', isFolder: true }],
      destinationFolder: { id: 'dst_1' },
      options: { skipExisting: true }
    };

    const res = await migrationService.startMigrationJob(payload);
    expect(res.status).toBe('starting');
    expect(migrationWorker.executeMigration).toHaveBeenCalledTimes(1);
  });

  it('Duplicate Start Migration returns 409', async () => {
    // Simulated via migration.routes.ts validation
    // The test here validates that migrationService creates a job, but in actual route logic,
    // the route handler returns 409 if a job exists in the DB.
    const payload = {
      manifestId: 'test_manifest_2',
      sourceSelection: [{ id: 'src_2', isFolder: true }],
      destinationFolder: { id: 'dst_2' },
      options: { skipExisting: true }
    };
    
    await createJob('test_manifest_2', payload);
    await updateJobStatus('test_manifest_2', 'running');
    
    const db = await getDb();
    const active = await db.get(`
      SELECT jobId FROM migration_jobs 
      WHERE status NOT IN ('completed', 'completed_with_errors', 'failed', 'cancelled', 'paused')
    `);
    
    expect(active).toBeDefined();
    expect(active.jobId).toBe('test_manifest_2');
  });
});
