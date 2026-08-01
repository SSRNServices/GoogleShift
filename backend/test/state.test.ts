import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MigrationStateManager } from '../src/services/MigrationStateManager';
import { ManifestStorage } from '../src/utils/ManifestStorage';
import { prisma, updateJobProgress } from '../src/utils/database';

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
    $transaction: vi.fn()
  },
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

  beforeEach(() => {
    stateManager = new MigrationStateManager('test-job');
    vi.clearAllMocks();
  });

  it('should emit progress monotonically from database', async () => {
    vi.mocked(prisma.migrationManifest.groupBy).mockResolvedValue([
      { isFolder: true, status: 'SUCCESS', _count: { id: 1 }, _sum: { size: BigInt(0) } },
      { isFolder: false, status: 'SUCCESS', _count: { id: 2 }, _sum: { size: BigInt(1500) } },
      { isFolder: false, status: 'PENDING', _count: { id: 8 }, _sum: { size: BigInt(3500) } }
    ] as any);

    await (stateManager as any).emitProgress();

    expect(updateJobProgress).toHaveBeenCalledWith('test-job', expect.objectContaining({
      completedFolders: 1,
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
