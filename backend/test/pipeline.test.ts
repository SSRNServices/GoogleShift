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
    updateItemStatus: vi.fn()
  }
}));

describe('Pipeline Invariants', () => {
  let stateManager: MigrationStateManager;

  beforeEach(() => {
    stateManager = new MigrationStateManager('test-job');
    vi.clearAllMocks();
  });

  it('should throw invariant violation if pending files remain on finalize', async () => {
    vi.mocked(prisma.migrationManifest.groupBy).mockResolvedValue([
      { status: 'PENDING', _count: { id: 5 } }
    ] as any);

    await expect(stateManager.finalizeMigration(0, 0)).rejects.toThrow('non-terminal items');
  });
  
  it('should queue children correctly', async () => {
    vi.mocked(prisma.migrationManifest.updateMany).mockResolvedValue({ count: 5 } as any);
    
    await stateManager.queueChildren('parent-id');
    expect(prisma.migrationManifest.updateMany).toHaveBeenCalledWith({
      where: { jobId: 'test-job', sourceParentId: 'parent-id', status: 'PENDING' },
      data: { status: 'QUEUED' }
    });
  });
});
