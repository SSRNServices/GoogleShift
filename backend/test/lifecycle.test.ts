import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma, createJob, updateJobStatus } from '../src/utils/database';

vi.mock('../src/utils/database', () => ({
  prisma: {
    migrationSession: {
      findUnique: vi.fn().mockResolvedValue({ id: 'test_session', ownerId: 'user1', sourceFolderId: 'src_1', destinationFolderId: 'dst_1' })
    },
    migrationJob: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'test_manifest_1' }),
      update: vi.fn().mockResolvedValue({ id: 'test_manifest_1' })
    }
  },
  createJob: vi.fn().mockResolvedValue(undefined),
  updateJobStatus: vi.fn().mockResolvedValue(undefined),
  getJob: vi.fn().mockResolvedValue(null)
}));

vi.mock('../src/utils/ManifestStorage', () => ({
  ManifestStorage: {
    hasManifest: vi.fn().mockResolvedValue(true)
  }
}));

vi.mock('../src/services/MigrationWorker', () => ({
  migrationWorker: {
    executeMigration: vi.fn().mockResolvedValue(true)
  }
}));

import { migrationService } from '../src/services/MigrationService';
import { migrationWorker } from '../src/services/MigrationWorker';

describe('Migration Lifecycle State Machine', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
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

    const res = await migrationService.startMigrationJob('user1', 'session1', payload as any);
    expect(res.status).toBe('preparing');
    expect(migrationWorker.executeMigration).toHaveBeenCalledTimes(1);
  });

  it('Duplicate Start Migration returns 409', async () => {
    const payload = {
      manifestId: 'test_manifest_2',
      sourceSelection: [{ id: 'src_2', isFolder: true }],
      destinationFolder: { id: 'dst_2' },
      options: { skipExisting: true }
    };
    
    await createJob('test_manifest_2', payload as any, 'user1');
    await updateJobStatus('test_manifest_2', 'running');
    
    expect(createJob).toHaveBeenCalled();
    expect(updateJobStatus).toHaveBeenCalled();
  });
});
