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
    $transaction: vi.fn()
  },
  getDb: vi.fn(),
  updateJobProgress: vi.fn(),
  updateJobStatus: vi.fn(),
  logJobEvent: vi.fn()
}));

vi.mock('../src/utils/ManifestStorage', () => ({
  ManifestStorage: {
    updateCreatedDestId: vi.fn(),
    updateItemStatus: vi.fn(),
    queueChildrenOf: vi.fn().mockResolvedValue({ count: 5 }),
    countItems: vi.fn()
  }
}));

describe('Pipeline Invariants', () => {
  let stateManager: MigrationStateManager;

  beforeEach(() => {
    stateManager = new MigrationStateManager('test-job');
    vi.clearAllMocks();
  });

  it('should throw invariant violation if pending files remain on finalize', async () => {
    vi.mocked(ManifestStorage.countItems).mockImplementation(async (_manifestId, filter) => {
      if (filter?.status === 'PENDING') return 5;
      return 0;
    });

    await expect(stateManager.finalizeMigration(0, 0)).rejects.toThrow('non-terminal items');
  });
  
  it('should queue children correctly', async () => {
    await stateManager.queueChildren('parent-id');
    expect(ManifestStorage.queueChildrenOf).toHaveBeenCalledWith('test-job', 'parent-id');
  });
});
