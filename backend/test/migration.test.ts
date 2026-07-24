import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrationService } from '../src/services/MigrationService';
import { RequestValidationError, ManifestError, ShortcutResolutionError } from '../src/utils/errors';
import * as database from '../src/utils/database';
import { driveService } from '../src/services/DriveService';

// Mock dependencies
vi.mock('../src/utils/database', () => ({
  getDb: vi.fn(),
  createJob: vi.fn(),
  updateJobStatus: vi.fn(),
  getJob: vi.fn(),
}));

vi.mock('../src/services/DriveService', () => ({
  driveService: {
    getFolderInfo: vi.fn(),
  },
}));

vi.mock('../src/services/MigrationWorker', () => ({
  migrationWorker: {
    executeMigration: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('MigrationService Validation and Serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('should reject missing source selection', async () => {
    await expect(migrationService.startMigrationJob({
      manifestId: 'manifest_123',
      sourceSelection: [],
      destinationFolder: { id: 'dest1', name: 'Dest', mimeType: 'folder' },
      options: validOptions
    })).rejects.toThrow(RequestValidationError);
  });

  it('should reject missing destination folder id', async () => {
    await expect(migrationService.startMigrationJob({
      manifestId: 'manifest_123',
      sourceSelection: [{ id: 'src1', name: 'Src', mimeType: 'folder' }],
      destinationFolder: { id: '', name: 'Dest', mimeType: 'folder' },
      options: validOptions
    })).rejects.toThrow(RequestValidationError);
  });

  it('should reject missing manifest id', async () => {
    await expect(migrationService.startMigrationJob({
      manifestId: '',
      sourceSelection: [{ id: 'src1', name: 'Src', mimeType: 'folder' }],
      destinationFolder: { id: 'dest1', name: 'Dest', mimeType: 'folder' },
      options: validOptions
    })).rejects.toThrow(RequestValidationError);
  });

  it('should reject if manifest is not found in database', async () => {
    const mockDb = {
      get: vi.fn().mockResolvedValue({ count: 0 })
    };
    (database.getDb as any).mockResolvedValue(mockDb);

    await expect(migrationService.startMigrationJob({
      manifestId: 'manifest_123',
      sourceSelection: [{ id: 'src1', name: 'Src', mimeType: 'folder' }],
      destinationFolder: { id: 'dest1', name: 'Dest', mimeType: 'folder' },
      options: validOptions
    })).rejects.toThrow(ManifestError);
  });

  it('should resolve shortcut items before starting job', async () => {
    const mockDb = {
      get: vi.fn().mockResolvedValue({ count: 1 })
    };
    (database.getDb as any).mockResolvedValue(mockDb);

    const mockTargetFolder = { id: 'real1', name: 'Real Folder', mimeType: 'application/vnd.google-apps.folder' };
    (driveService.getFolderInfo as any).mockResolvedValue(mockTargetFolder);

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
      get: vi.fn().mockImplementation((query) => {
         if (query.includes('count(*)')) return Promise.resolve({ count: 1 });
         if (query.includes('SUM')) return Promise.resolve({ folders: 1, files: 1, bytes: 100 });
         return Promise.resolve(null);
      }),
      run: vi.fn()
    };
    (database.getDb as any).mockResolvedValue(mockDbLocal);

    const res = await migrationService.startMigrationJob(payload);

    expect(res.jobId).toBe('manifest_123');
    expect(driveService.getFolderInfo).toHaveBeenCalledWith('source', 'real1');
    expect(database.createJob).toHaveBeenCalled();
    
    // Check that payload was mutated correctly
    expect(payload.sourceSelection[0]?.id).toBe('real1');
    expect(payload.sourceSelection[0]?.name).toBe('Real Folder');
    expect(payload.sourceSelection[0]?.parentId).toBe('parent1');
  });

  it('should throw ShortcutResolutionError if shortcut lacks targetId', async () => {
    const mockDb = {
      get: vi.fn().mockImplementation((query) => {
         if (query.includes('count(*)')) return Promise.resolve({ count: 1 });
         if (query.includes('SUM')) return Promise.resolve({ folders: 1, files: 1, bytes: 100 });
         return Promise.resolve(null);
      }),
      run: vi.fn()
    };
    (database.getDb as any).mockResolvedValue(mockDb);

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

    await expect(migrationService.startMigrationJob(payload)).rejects.toThrow(ShortcutResolutionError);
  });
});
