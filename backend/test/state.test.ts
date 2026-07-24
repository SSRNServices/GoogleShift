import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MigrationStateManager } from '../src/services/MigrationStateManager';
import { ManifestStorage } from '../src/utils/ManifestStorage';
import { getDb, updateJobProgress } from '../src/utils/database';

vi.mock('../src/utils/database', () => ({
  getDb: vi.fn(),
  updateJobProgress: vi.fn(),
  updateJobStatus: vi.fn(),
  logJobEvent: vi.fn()
}));

vi.mock('../src/utils/ManifestStorage', () => ({
  ManifestStorage: {
    updateItemStatus: vi.fn()
  }
}));

describe('MigrationStateManager', () => {
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

  it('should emit progress monotonically from database', async () => {
    mockDb.get.mockResolvedValue({
      completedFolders: 1,
      completedFiles: 2,
      transferredBytes: 1500,
      failedFiles: 0,
      totalFolders: 1,
      totalFiles: 10,
      totalBytes: 5000
    });

    await stateManager.emitProgress();

    expect(updateJobProgress).toHaveBeenCalledWith('test-job', expect.objectContaining({
      completedFolders: 1,
      completedFiles: 2,
      transferredBytes: 1500,
      failedFiles: 0,
      totalFolders: 1,
      totalFiles: 10,
      totalBytes: 5000
    }));
  });

  it('should commit success', async () => {
    mockDb.get.mockResolvedValue({
      completedFiles: 1,
      transferredBytes: 100
    });

    await stateManager.commitSuccess({ id: 'file1' } as any);

    expect(ManifestStorage.updateItemStatus).toHaveBeenCalledWith('test-job', 'file1', 'SUCCESS');
  });
});
