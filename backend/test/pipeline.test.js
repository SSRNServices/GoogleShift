"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const MigrationStateManager_1 = require("../src/services/MigrationStateManager");
const database_1 = require("../src/utils/database");
vitest_1.vi.mock('../src/utils/database', () => ({
    getDb: vitest_1.vi.fn(),
    updateJobProgress: vitest_1.vi.fn(),
    updateJobStatus: vitest_1.vi.fn(),
    logJobEvent: vitest_1.vi.fn()
}));
vitest_1.vi.mock('../src/utils/ManifestStorage', () => ({
    ManifestStorage: {
        updateCreatedDestId: vitest_1.vi.fn(),
        updateItemStatus: vitest_1.vi.fn()
    }
}));
(0, vitest_1.describe)('Pipeline Invariants', () => {
    let stateManager;
    let mockDb;
    (0, vitest_1.beforeEach)(() => {
        stateManager = new MigrationStateManager_1.MigrationStateManager('test-job');
        mockDb = {
            get: vitest_1.vi.fn(),
            run: vitest_1.vi.fn()
        };
        database_1.getDb.mockResolvedValue(mockDb);
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.it)('should throw invariant violation if file sums do not match total', async () => {
        mockDb.get.mockResolvedValue({
            queued: 10,
            uploading: 0,
            verifying: 0,
            success: 5,
            failed: 2,
            pending: 0,
            total: 20 // 10+5+2 = 17 != 20
        });
        await (0, vitest_1.expect)(stateManager.validateManifestConsistency()).rejects.toThrow('Manifest states do not sum to total');
    });
    (0, vitest_1.it)('should throw invariant violation if pending files remain on finalize', async () => {
        mockDb.get.mockResolvedValue({
            pending: 5,
            queued: 0,
            uploading: 0,
            verifying: 0,
            failed: 0
        });
        await (0, vitest_1.expect)(stateManager.finalizeMigration(0, 0)).rejects.toThrow('non-terminal items');
    });
    (0, vitest_1.it)('should queue children correctly', async () => {
        mockDb.run.mockResolvedValue({ changes: 5 });
        mockDb.get.mockResolvedValue({}); // for emitProgress
        await stateManager.queueChildren('parent-id');
        (0, vitest_1.expect)(mockDb.run).toHaveBeenCalledWith(`UPDATE migration_manifest SET status = 'QUEUED' WHERE jobId = ? AND sourceParentId = ? AND status = 'PENDING'`, ['test-job', 'parent-id']);
    });
});
//# sourceMappingURL=pipeline.test.js.map