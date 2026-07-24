import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MigrationStateManager } from '../src/services/MigrationStateManager';
import { ManifestStorage } from '../src/utils/ManifestStorage';
import { getDb } from '../src/utils/database';

vi.mock('../src/utils/database', () => ({
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
  let mockDb: any;

  beforeEach(() => {
    stateManager = new MigrationStateManager('test-job');
    mockDb = {
      get: vi.fn(),
      run: vi.fn()
    };
    (getDb as any).mockResolvedValue(mockDb);
    vi.clearAllMocks();
  });

  it('should commit folder success automatically inside a transaction', async () => {
    mockDb.get.mockResolvedValue({
      completedFolders: 1,
      totalFolders: 10
    });

    await stateManager.commitFolderSuccess('source-folder-1', 'dest-folder-1');

    expect(mockDb.run).toHaveBeenCalledWith('BEGIN TRANSACTION');
    expect(ManifestStorage.updateCreatedDestId).toHaveBeenCalledWith('test-job', 'source-folder-1', 'dest-folder-1');
    expect(ManifestStorage.updateItemStatus).toHaveBeenCalledWith('test-job', 'source-folder-1', 'SUCCESS');
    expect(mockDb.run).toHaveBeenCalledWith('COMMIT');
  });

  it('should rollback transaction on failure', async () => {
    mockDb.get.mockResolvedValue({});
    (ManifestStorage.updateCreatedDestId as any).mockRejectedValue(new Error('DB Error'));

    await expect(stateManager.commitFolderSuccess('source-folder-1', 'dest-folder-1')).rejects.toThrow('DB Error');

    expect(mockDb.run).toHaveBeenCalledWith('BEGIN TRANSACTION');
    expect(mockDb.run).toHaveBeenCalledWith('ROLLBACK');
  });
});
