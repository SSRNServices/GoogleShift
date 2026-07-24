"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const MigrationService_1 = require("../src/services/MigrationService");
const errors_1 = require("../src/utils/errors");
const database = __importStar(require("../src/utils/database"));
const DriveService_1 = require("../src/services/DriveService");
// Mock dependencies
vitest_1.vi.mock('../src/utils/database', () => ({
    getDb: vitest_1.vi.fn(),
    createJob: vitest_1.vi.fn(),
    updateJobStatus: vitest_1.vi.fn(),
    getJob: vitest_1.vi.fn(),
}));
vitest_1.vi.mock('../src/services/DriveService', () => ({
    driveService: {
        getFolderInfo: vitest_1.vi.fn(),
    },
}));
vitest_1.vi.mock('../src/services/MigrationWorker', () => ({
    migrationWorker: {
        executeMigration: vitest_1.vi.fn().mockResolvedValue(undefined),
    },
}));
(0, vitest_1.describe)('MigrationService Validation and Serialization', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    const validOptions = {
        preserveStructure: true,
        overwriteExisting: false,
        skipExisting: true,
        renameConflicts: false,
        verifyChecksums: false,
        keepOriginalDate: true,
        transferDocsAsPdf: false,
    };
    (0, vitest_1.it)('should reject missing source selection', async () => {
        await (0, vitest_1.expect)(MigrationService_1.migrationService.startMigrationJob({
            manifestId: 'manifest_123',
            sourceSelection: [],
            destinationFolder: { id: 'dest1', name: 'Dest', mimeType: 'folder' },
            options: validOptions
        })).rejects.toThrow(errors_1.RequestValidationError);
    });
    (0, vitest_1.it)('should reject missing destination folder id', async () => {
        await (0, vitest_1.expect)(MigrationService_1.migrationService.startMigrationJob({
            manifestId: 'manifest_123',
            sourceSelection: [{ id: 'src1', name: 'Src', mimeType: 'folder' }],
            destinationFolder: { id: '', name: 'Dest', mimeType: 'folder' },
            options: validOptions
        })).rejects.toThrow(errors_1.RequestValidationError);
    });
    (0, vitest_1.it)('should reject missing manifest id', async () => {
        await (0, vitest_1.expect)(MigrationService_1.migrationService.startMigrationJob({
            manifestId: '',
            sourceSelection: [{ id: 'src1', name: 'Src', mimeType: 'folder' }],
            destinationFolder: { id: 'dest1', name: 'Dest', mimeType: 'folder' },
            options: validOptions
        })).rejects.toThrow(errors_1.RequestValidationError);
    });
    (0, vitest_1.it)('should reject if manifest is not found in database', async () => {
        const mockDb = {
            get: vitest_1.vi.fn().mockResolvedValue({ count: 0 })
        };
        database.getDb.mockResolvedValue(mockDb);
        await (0, vitest_1.expect)(MigrationService_1.migrationService.startMigrationJob({
            manifestId: 'manifest_123',
            sourceSelection: [{ id: 'src1', name: 'Src', mimeType: 'folder' }],
            destinationFolder: { id: 'dest1', name: 'Dest', mimeType: 'folder' },
            options: validOptions
        })).rejects.toThrow(errors_1.ManifestError);
    });
    (0, vitest_1.it)('should resolve shortcut items before starting job', async () => {
        const mockDb = {
            get: vitest_1.vi.fn().mockResolvedValue({ count: 1 })
        };
        database.getDb.mockResolvedValue(mockDb);
        const mockTargetFolder = { id: 'real1', name: 'Real Folder', mimeType: 'application/vnd.google-apps.folder' };
        DriveService_1.driveService.getFolderInfo.mockResolvedValue(mockTargetFolder);
        const payload = {
            manifestId: 'manifest_123',
            sourceSelection: [{
                    id: 'shortcut1',
                    name: 'Shortcut',
                    mimeType: 'application/vnd.google-apps.shortcut',
                    parentId: 'parent1',
                    shortcutDetails: { targetId: 'real1' }
                }],
            destinationFolder: { id: 'dest1', name: 'Dest', mimeType: 'folder' },
            options: validOptions
        };
        const mockDbLocal = {
            get: vitest_1.vi.fn().mockImplementation((query) => {
                if (query.includes('count(*)'))
                    return Promise.resolve({ count: 1 });
                if (query.includes('SUM'))
                    return Promise.resolve({ folders: 1, files: 1, bytes: 100 });
                return Promise.resolve(null);
            }),
            run: vitest_1.vi.fn()
        };
        database.getDb.mockResolvedValue(mockDbLocal);
        const res = await MigrationService_1.migrationService.startMigrationJob(payload);
        (0, vitest_1.expect)(res.jobId).toBe('manifest_123');
        (0, vitest_1.expect)(DriveService_1.driveService.getFolderInfo).toHaveBeenCalledWith('source', 'real1');
        (0, vitest_1.expect)(database.createJob).toHaveBeenCalled();
        // Check that payload was mutated correctly
        (0, vitest_1.expect)(payload.sourceSelection[0]?.id).toBe('real1');
        (0, vitest_1.expect)(payload.sourceSelection[0]?.name).toBe('Real Folder');
        (0, vitest_1.expect)(payload.sourceSelection[0]?.parentId).toBe('parent1');
    });
    (0, vitest_1.it)('should throw ShortcutResolutionError if shortcut lacks targetId', async () => {
        const mockDb = {
            get: vitest_1.vi.fn().mockImplementation((query) => {
                if (query.includes('count(*)'))
                    return Promise.resolve({ count: 1 });
                if (query.includes('SUM'))
                    return Promise.resolve({ folders: 1, files: 1, bytes: 100 });
                return Promise.resolve(null);
            }),
            run: vitest_1.vi.fn()
        };
        database.getDb.mockResolvedValue(mockDb);
        const payload = {
            manifestId: 'manifest_123',
            sourceSelection: [{
                    id: 'shortcut1',
                    name: 'Shortcut',
                    mimeType: 'application/vnd.google-apps.shortcut',
                    parentId: 'parent1'
                    // missing shortcutDetails
                }],
            destinationFolder: { id: 'dest1', name: 'Dest', mimeType: 'folder' },
            options: validOptions
        };
        await (0, vitest_1.expect)(MigrationService_1.migrationService.startMigrationJob(payload)).rejects.toThrow(errors_1.ShortcutResolutionError);
    });
});
//# sourceMappingURL=migration.test.js.map