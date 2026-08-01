import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MigrationStateManager } from '../src/services/MigrationStateManager';
import { prisma } from '../src/utils/database';

vi.mock('../src/utils/database', () => ({
  prisma: {
    migrationManifest: {
      groupBy: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn()
    },
    migrationJob: {
      update: vi.fn()
    },
    migrationLog: {
      create: vi.fn()
    },
    $transaction: vi.fn((cb: any) => {
      if (typeof cb === 'function') return cb(prisma);
      return Promise.all(cb);
    })
  },
  getDb: vi.fn(),
  updateJobProgress: vi.fn(),
  updateJobStatus: vi.fn(),
  logJobEvent: vi.fn()
}));

vi.mock('../src/utils/ManifestStorage', () => ({
  ManifestStorage: {
    updateCreatedDestId: vi.fn(),
    updateItemStatus: vi.fn()
  }
}));

describe('MigrationStateManager - Folders', () => {
  let stateManager: MigrationStateManager;

  beforeEach(() => {
    stateManager = new MigrationStateManager('test-job');
    vi.clearAllMocks();
  });

  it('should commit folder success automatically inside a transaction', async () => {
    vi.mocked(prisma.migrationManifest.update).mockResolvedValue({ id: 'source-folder-1', createdDestId: 'dest-folder-1', status: 'SUCCESS' } as any);

    await stateManager.commitFolderSuccess('source-folder-1', 'dest-folder-1');

    expect(prisma.migrationManifest.update).toHaveBeenCalledWith({
      where: { jobId_id: { jobId: 'test-job', id: 'source-folder-1' } },
      data: { createdDestId: 'dest-folder-1', status: 'SUCCESS' }
    });
  });

  it('should throw error on transaction failure', async () => {
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error('DB Error'));

    await expect(stateManager.commitFolderSuccess('source-folder-1', 'dest-folder-1')).rejects.toThrow('DB Error');
  });
});
