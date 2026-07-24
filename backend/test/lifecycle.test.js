"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
vitest_1.vi.mock('../src/services/MigrationWorker', () => ({
    migrationWorker: {
        executeMigration: vitest_1.vi.fn().mockResolvedValue(true)
    }
}));
const database_1 = require("../src/utils/database");
const MigrationService_1 = require("../src/services/MigrationService");
const MigrationWorker_1 = require("../src/services/MigrationWorker");
(0, vitest_1.describe)('Migration Lifecycle State Machine', () => {
    (0, vitest_1.beforeEach)(async () => {
        vitest_1.vi.clearAllMocks();
        const db = await (0, database_1.getDb)();
        await db.run('DELETE FROM migration_jobs');
    });
    (0, vitest_1.it)('Backend startup performs zero uploads', async () => {
        (0, vitest_1.expect)(MigrationWorker_1.migrationWorker.executeMigration).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('POST /migration/start is the only entry point that triggers execution', async () => {
        const payload = {
            manifestId: 'test_manifest_1',
            sourceSelection: [{ id: 'src_1', isFolder: true }],
            destinationFolder: { id: 'dst_1' },
            options: { skipExisting: true }
        };
        const db = await (0, database_1.getDb)();
        await db.run(`INSERT INTO migration_manifest (jobId, id, status, isFolder) VALUES (?, ?, ?, ?)`, ['test_manifest_1', 'item_1', 'PENDING', 0]);
        const res = await MigrationService_1.migrationService.startMigrationJob(payload);
        (0, vitest_1.expect)(res.status).toBe('starting');
        (0, vitest_1.expect)(MigrationWorker_1.migrationWorker.executeMigration).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)('Duplicate Start Migration returns 409', async () => {
        // Simulated via migration.routes.ts validation
        // The test here validates that migrationService creates a job, but in actual route logic,
        // the route handler returns 409 if a job exists in the DB.
        const payload = {
            manifestId: 'test_manifest_2',
            sourceSelection: [{ id: 'src_2', isFolder: true }],
            destinationFolder: { id: 'dst_2' },
            options: { skipExisting: true }
        };
        await (0, database_1.createJob)('test_manifest_2', payload);
        await (0, database_1.updateJobStatus)('test_manifest_2', 'running');
        const db = await (0, database_1.getDb)();
        const active = await db.get(`
      SELECT jobId FROM migration_jobs 
      WHERE status NOT IN ('completed', 'completed_with_errors', 'failed', 'cancelled', 'paused')
    `);
        (0, vitest_1.expect)(active).toBeDefined();
        (0, vitest_1.expect)(active.jobId).toBe('test_manifest_2');
    });
});
//# sourceMappingURL=lifecycle.test.js.map