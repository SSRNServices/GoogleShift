import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MigrationStateManager } from '../src/services/MigrationStateManager';
import { prisma } from '../src/utils/database';

vi.mock('../src/utils/database', () => ({
  prisma: {
    migrationManifest: {
      update: vi.fn().mockResolvedValue({})
    },
    $transaction: vi.fn((cb: any) => Promise.all(cb))
  },
  updateJobProgress: vi.fn(),
  updateJobStatus: vi.fn(),
  logJobEvent: vi.fn()
}));

describe('Database Concurrency and State Manager', () => {
  let stateManager: MigrationStateManager;
  const JOB_ID = 'concurrency_test_job';

  beforeEach(async () => {
    vi.clearAllMocks();
    stateManager = new MigrationStateManager(JOB_ID);
  });

  afterEach(() => {
     vi.restoreAllMocks();
  });

  it('should serialize 100 concurrent folder success commits', async () => {
    const promises: Promise<void>[] = [];
    
    for (let i = 0; i < 100; i++) {
       promises.push(stateManager.commitFolderSuccess(`folder_${i}`, `dest_${i}`));
    }
    
    await Promise.all(promises);
    
    expect(prisma.migrationManifest.update).toHaveBeenCalledTimes(100);
    expect(stateManager.getPendingWriteCount()).toBe(0);
  });
});
