"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const MigrationStateManager_1 = require("../src/services/MigrationStateManager");
const database_1 = require("../src/utils/database");
const ManifestStorage_1 = require("../src/utils/ManifestStorage");
(0, vitest_1.describe)('Database Concurrency and State Manager', () => {
    let db;
    let stateManager;
    const JOB_ID = 'concurrency_test_job';
    (0, vitest_1.beforeEach)(async () => {
        db = await (0, database_1.getDb)();
        await db.run('DELETE FROM migration_manifest WHERE jobId = ?', [JOB_ID]);
        await db.run('DELETE FROM migration_jobs WHERE jobId = ?', [JOB_ID]);
        // Insert mock job
        await db.run('INSERT INTO migration_jobs (jobId, status) VALUES (?, ?)', [JOB_ID, 'running']);
        // Create 100 folders
        for (let i = 0; i < 100; i++) {
            await ManifestStorage_1.ManifestStorage.insertItem({
                id: `folder_${i}`,
                jobId: JOB_ID,
                sourceId: `folder_${i}`,
                sourceParentId: 'root',
                destParentId: 'root',
                createdDestId: null,
                name: `Folder ${i}`,
                mimeType: 'application/vnd.google-apps.folder',
                size: 0,
                originalId: null,
                originalMimeType: null,
                status: 'PENDING',
                isFolder: true,
                depth: 0,
                retryCount: 0
            });
        }
        stateManager = new MigrationStateManager_1.MigrationStateManager(JOB_ID);
    });
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)('should serialize 100 concurrent folder success commits without SQLITE_BUSY', async () => {
        const promises = [];
        // Fire 100 commits concurrently!
        for (let i = 0; i < 100; i++) {
            promises.push(stateManager.commitFolderSuccess(`folder_${i}`, `dest_${i}`));
        }
        await Promise.all(promises);
        // Verify they all succeeded
        const count = await db.get('SELECT COUNT(*) as count FROM migration_manifest WHERE jobId = ? AND status = ?', [JOB_ID, 'SUCCESS']);
        (0, vitest_1.expect)(count.count).toBe(100);
        // Verify pendingDBWrites is 0
        (0, vitest_1.expect)(stateManager.getPendingWriteCount()).toBe(0);
    });
});
//# sourceMappingURL=concurrency.test.js.map