"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const DriveService_1 = require("../src/services/DriveService");
// Mock dependencies
vitest_1.vi.mock('../src/oauth/OAuthService', () => ({
    oauthService: {
        getAuthenticatedClient: vitest_1.vi.fn(() => ({})), // dummy auth
    }
}));
const mockFilesList = vitest_1.vi.fn();
const mockFilesGet = vitest_1.vi.fn();
vitest_1.vi.mock('googleapis', () => ({
    google: {
        drive: vitest_1.vi.fn(() => ({
            files: {
                list: mockFilesList,
                get: mockFilesGet
            }
        }))
    }
}));
(0, vitest_1.describe)('DriveService - getSelectionSummary', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    const onProgress = vitest_1.vi.fn();
    (0, vitest_1.it)('should correctly count a single file', async () => {
        mockFilesGet.mockResolvedValueOnce({
            data: { name: 'test.txt', size: '100' }
        });
        const summary = await DriveService_1.driveService.getSelectionSummary('source', [{ id: 'file1', isFolder: false }], onProgress);
        (0, vitest_1.expect)(summary).toEqual(vitest_1.expect.objectContaining({ folders: 0, files: 1, bytes: 100 }));
    });
    (0, vitest_1.it)('should estimate Google Docs as 0 bytes', async () => {
        mockFilesGet.mockResolvedValueOnce({
            data: { name: 'doc', mimeType: 'application/vnd.google-apps.document' }
        });
        const summary = await DriveService_1.driveService.getSelectionSummary('source', [{ id: 'doc1', isFolder: false }], onProgress);
        (0, vitest_1.expect)(summary).toEqual(vitest_1.expect.objectContaining({ folders: 0, files: 1, bytes: 0 }));
    });
    (0, vitest_1.it)('should count a single folder with no children', async () => {
        mockFilesGet.mockResolvedValueOnce({
            data: { name: 'Empty Folder', mimeType: 'application/vnd.google-apps.folder' }
        });
        mockFilesList.mockResolvedValueOnce({
            data: { files: [] }
        });
        const summary = await DriveService_1.driveService.getSelectionSummary('source', [{ id: 'folder1', isFolder: true }], onProgress);
        (0, vitest_1.expect)(summary).toEqual(vitest_1.expect.objectContaining({ folders: 1, files: 0, bytes: 0 }));
    });
    (0, vitest_1.it)('should traverse nested folders', async () => {
        // 1 selected root folder -> 1 folder
        mockFilesGet.mockResolvedValueOnce({
            data: { name: 'Root Folder', mimeType: 'application/vnd.google-apps.folder' }
        });
        // root -> returns 1 subfolder, 1 file
        mockFilesList.mockImplementation(async (args) => {
            const q = args.q;
            if (q.includes("'root1' in parents")) {
                return {
                    data: {
                        files: [
                            { id: 'sub1', name: 'Sub', mimeType: 'application/vnd.google-apps.folder' },
                            { id: 'file1', name: 'File1', size: '50' }
                        ]
                    }
                };
            }
            else if (q.includes("'sub1' in parents")) {
                return {
                    data: {
                        files: [
                            { id: 'file2', name: 'File2', size: '75' }
                        ]
                    }
                };
            }
            return { data: { files: [] } };
        });
        const summary = await DriveService_1.driveService.getSelectionSummary('source', [{ id: 'root1', isFolder: true }], onProgress);
        // root + sub1 = 2 folders. file1 + file2 = 2 files. 50 + 75 = 125 bytes.
        (0, vitest_1.expect)(summary).toEqual(vitest_1.expect.objectContaining({ folders: 2, files: 2, bytes: 125 }));
    });
    (0, vitest_1.it)('should correctly traverse a shortcut pointing to a folder', async () => {
        // Mock the initial get for the selected shortcut
        mockFilesGet.mockResolvedValueOnce({
            data: {
                name: 'Shortcut to Folder',
                mimeType: 'application/vnd.google-apps.shortcut',
                shortcutDetails: { targetId: 'targetFolder1', targetMimeType: 'application/vnd.google-apps.folder' }
            }
        });
        // When traversing targetFolder1, return 1 file
        mockFilesList.mockImplementation(async (args) => {
            const q = args.q;
            if (q.includes("'targetFolder1' in parents")) {
                return {
                    data: {
                        files: [
                            { id: 'fileA', name: 'FileA', size: '10' }
                        ]
                    }
                };
            }
            return { data: { files: [] } };
        });
        const summary = await DriveService_1.driveService.getSelectionSummary('source', [{ id: 'shortcut1', isFolder: true }], onProgress);
        // 1 shortcut resolved to folder = 1 folder. 1 file inside.
        (0, vitest_1.expect)(summary).toEqual(vitest_1.expect.objectContaining({ folders: 1, files: 1, bytes: 10 }));
    });
    (0, vitest_1.it)('should not infinitely loop on cyclic shortcuts', async () => {
        mockFilesGet.mockResolvedValueOnce({
            data: { name: 'Folder', mimeType: 'application/vnd.google-apps.folder' }
        });
        mockFilesList.mockImplementation(async (args) => {
            const q = args.q;
            if (q.includes("'f1' in parents")) {
                return {
                    data: {
                        files: [
                            // shortcut points back to itself
                            {
                                id: 'shortcut1',
                                name: 'Cycle',
                                mimeType: 'application/vnd.google-apps.shortcut',
                                shortcutDetails: { targetId: 'f1', targetMimeType: 'application/vnd.google-apps.folder' }
                            }
                        ]
                    }
                };
            }
            return { data: { files: [] } };
        });
        const summary = await DriveService_1.driveService.getSelectionSummary('source', [{ id: 'f1', isFolder: true }], onProgress);
        // root = 1 folder. shortcut -> already visited, skipped.
        (0, vitest_1.expect)(summary).toEqual(vitest_1.expect.objectContaining({ folders: 1, files: 0, bytes: 0 }));
    });
    (0, vitest_1.it)('should handle large folders using pagination', async () => {
        mockFilesGet.mockResolvedValueOnce({
            data: { name: 'Large Folder', mimeType: 'application/vnd.google-apps.folder' }
        });
        // First page: 1000 files, nextPageToken = 'page2'
        // Second page: 500 files, no nextPageToken
        mockFilesList.mockImplementation(async (args) => {
            if (args.pageToken === undefined) {
                const files = Array.from({ length: 1000 }, (_, i) => ({ id: `file_${i}`, size: '1' }));
                return { data: { files, nextPageToken: 'page2' } };
            }
            else if (args.pageToken === 'page2') {
                const files = Array.from({ length: 500 }, (_, i) => ({ id: `file_${i + 1000}`, size: '1' }));
                return { data: { files } };
            }
        });
        const summary = await DriveService_1.driveService.getSelectionSummary('source', [{ id: 'large1', isFolder: true }], onProgress);
        (0, vitest_1.expect)(summary).toEqual(vitest_1.expect.objectContaining({ folders: 1, files: 1500, bytes: 1500 }));
    });
});
//# sourceMappingURL=summary.test.js.map