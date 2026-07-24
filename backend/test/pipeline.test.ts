import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MigrationStateManager } from '../src/services/MigrationStateManager';
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

describe('Pipeline Invariants', () => {
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

  it('should throw invariant violation if file sums do not match total', async () => {
    mockDb.get.mockResolvedValue({
      queued: 10,
      uploading: 0,
      verifying: 0,
      success: 5,
      failed: 2,
      pending: 0,
      total: 20 // 10+5+2 = 17 != 20
    });

    await expect(stateManager.validateManifestConsistency()).rejects.toThrow('Manifest states do not sum to total');
  });

  it('should throw invariant violation if pending files remain on finalize', async () => {
    mockDb.get.mockResolvedValue({
      pending: 5,
      queued: 0,
      uploading: 0,
      verifying: 0,
      failed: 0
    });

    await expect(stateManager.finalizeMigration(0, 0)).rejects.toThrow('non-terminal items');
  });
  
  it('should queue children correctly', async () => {
    mockDb.run.mockResolvedValue({ changes: 5 });
    mockDb.get.mockResolvedValue({}); // for emitProgress
    
    await stateManager.queueChildren('parent-id');
    expect(mockDb.run).toHaveBeenCalledWith(
      `UPDATE migration_manifest SET status = 'QUEUED' WHERE jobId = ? AND sourceParentId = ? AND status = 'PENDING'`,
      ['test-job', 'parent-id']
    );
  });
});
