"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const MigrationStateManager_1 = require("../src/services/MigrationStateManager");
const ManifestStorage_1 = require("../src/utils/ManifestStorage");
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
(0, vitest_1.describe)('MigrationStateManager - Folders', () => {
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
    (0, vitest_1.it)('should commit folder success automatically inside a transaction', async () => {
        mockDb.get.mockResolvedValue({
            completedFolders: 1,
            totalFolders: 10
        });
        await stateManager.commitFolderSuccess('source-folder-1', 'dest-folder-1');
        (0, vitest_1.expect)(mockDb.run).toHaveBeenCalledWith('BEGIN TRANSACTION');
        (0, vitest_1.expect)(ManifestStorage_1.ManifestStorage.updateCreatedDestId).toHaveBeenCalledWith('test-job', 'source-folder-1', 'dest-folder-1');
        (0, vitest_1.expect)(ManifestStorage_1.ManifestStorage.updateItemStatus).toHaveBeenCalledWith('test-job', 'source-folder-1', 'SUCCESS');
        (0, vitest_1.expect)(mockDb.run).toHaveBeenCalledWith('COMMIT');
    });
    (0, vitest_1.it)('should rollback transaction on failure', async () => {
        mockDb.get.mockResolvedValue({});
        ManifestStorage_1.ManifestStorage.updateCreatedDestId.mockRejectedValue(new Error('DB Error'));
        await (0, vitest_1.expect)(stateManager.commitFolderSuccess('source-folder-1', 'dest-folder-1')).rejects.toThrow('DB Error');
        (0, vitest_1.expect)(mockDb.run).toHaveBeenCalledWith('BEGIN TRANSACTION');
        (0, vitest_1.expect)(mockDb.run).toHaveBeenCalledWith('ROLLBACK');
    });
});
//# sourceMappingURL=folder.test.js.map