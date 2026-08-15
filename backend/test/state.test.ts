import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MigrationStateManager } from '../src/services/MigrationStateManager';
import { ManifestStorage } from '../src/utils/ManifestStorage';
import { updateJobProgress } from '../src/utils/database';

vi.mock('../src/utils/database', () => ({
  prisma: {
    migrationJob: {
      update: vi.fn()
    },
    migrationLog: {
      create: vi.fn()
    },
    $transaction: vi.fn()
  },
  getDb: vi.fn(),
  updateJobProgress: vi.fn(),
  updateJobStatus: vi.fn(),
  logJobEvent: vi.fn()
}));

vi.mock('../src/utils/ManifestStorage', () => ({
  ManifestStorage: {
    updateItemStatus: vi.fn(),
    getSummaryStats: vi.fn().mockResolvedValue({
      totalFolders: 1,
      totalFiles: 10,
      totalBytes: 5000,
      completedFiles: 2,
      failedFiles: 0,
      transferredBytes: 1500
    }),
    getPendingFiles: vi.fn().mockResolvedValue([]),
    getPendingFoldersByDepth: vi.fn().mockResolvedValue([])
  }
}));

describe('MigrationStateManager', () => {
  let stateManager: MigrationStateManager;

  beforeEach(() => {
    stateManager = new MigrationStateManager('test-job');
    vi.clearAllMocks();
  });

  it('should emit progress monotonically from storage provider', async () => {
    (stateManager as any).lastEmitTime = 0;
    await (stateManager as any).emitProgress();

    expect(updateJobProgress).toHaveBeenCalledWith('test-job', expect.objectContaining({
      completedFiles: 2,
      transferredBytes: BigInt(1500),
      failedFiles: 0,
      totalFolders: 1,
      totalFiles: 10,
      totalBytes: BigInt(5000)
    }));
  });

  it('should commit success', async () => {
    await stateManager.commitSuccess({ id: 'file1' } as any);

    expect(ManifestStorage.updateItemStatus).toHaveBeenCalledWith('test-job', 'file1', 'SUCCESS');
  });
});
