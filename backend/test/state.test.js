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
        updateItemStatus: vitest_1.vi.fn()
    }
}));
(0, vitest_1.describe)('MigrationStateManager', () => {
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
    (0, vitest_1.it)('should emit progress monotonically from database', async () => {
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
        (0, vitest_1.expect)(database_1.updateJobProgress).toHaveBeenCalledWith('test-job', vitest_1.expect.objectContaining({
            completedFolders: 1,
            completedFiles: 2,
            transferredBytes: 1500,
            failedFiles: 0,
            totalFolders: 1,
            totalFiles: 10,
            totalBytes: 5000
        }));
    });
    (0, vitest_1.it)('should commit success', async () => {
        mockDb.get.mockResolvedValue({
            completedFiles: 1,
            transferredBytes: 100
        });
        await stateManager.commitSuccess({ id: 'file1' });
        (0, vitest_1.expect)(ManifestStorage_1.ManifestStorage.updateItemStatus).toHaveBeenCalledWith('test-job', 'file1', 'SUCCESS');
    });
});
//# sourceMappingURL=state.test.js.map