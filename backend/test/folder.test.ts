import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MigrationStateManager } from '../src/services/MigrationStateManager';
import { ManifestStorage } from '../src/utils/ManifestStorage';

vi.mock('../src/utils/database', () => ({
  prisma: {
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
    updateCreatedDestId: vi.fn().mockResolvedValue(undefined),
    updateItemStatus: vi.fn().mockResolvedValue(undefined)
  }
}));

describe('MigrationStateManager - Folders', () => {
  let stateManager: MigrationStateManager;

  beforeEach(() => {
    stateManager = new MigrationStateManager('test-job');
    vi.clearAllMocks();
  });

  it('should commit folder success automatically inside storage provider', async () => {
    await stateManager.commitFolderSuccess('source-folder-1', 'dest-folder-1');

    expect(ManifestStorage.updateCreatedDestId).toHaveBeenCalledWith('test-job', 'source-folder-1', 'dest-folder-1');
    expect(ManifestStorage.updateItemStatus).toHaveBeenCalledWith('test-job', 'source-folder-1', 'SUCCESS');
  });

  it('should throw error on storage failure', async () => {
    vi.mocked(ManifestStorage.updateCreatedDestId).mockRejectedValueOnce(new Error('Storage Error'));

    await expect(stateManager.commitFolderSuccess('source-folder-1', 'dest-folder-1')).rejects.toThrow('Storage Error');
  });
});
