import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrationService } from '../src/services/MigrationService';
import { RequestValidationError, ManifestError, ShortcutResolutionError } from '../src/utils/errors';
import { prisma } from '../src/utils/database';

vi.mock('../src/utils/database', () => ({
  prisma: {
    migrationSession: {
      findUnique: vi.fn().mockResolvedValue({ id: 'test_session', ownerId: 'user1', sourceFolderId: 'src_1', destinationFolderId: 'dst_1' })
    },
    migrationManifest: {
      findUnique: vi.fn().mockResolvedValue({ id: 'test_manifest_1' }),
      findFirst: vi.fn().mockResolvedValue({ id: 'test_manifest_1' }),
      findMany: vi.fn().mockResolvedValue([])
    },
    migrationJob: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'test_manifest_1' })
    }
  },
  getDb: vi.fn(),
  createJob: vi.fn(),
  updateJobStatus: vi.fn(),
  getJob: vi.fn()
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
    verifyChecksums: true,
    keepOriginalDate: true,
    transferDocsAsPdf: false,
    preservePermissions: false,
    threads: 4,
    chunkSize: 16 * 1024 * 1024,
    skipErrors: false,
    dryRun: false
  };

  it('should validate request structure and throw RequestValidationError on invalid options', async () => {
    await expect(migrationService.startMigrationJob('user1', 'session1', {
      manifestId: 'manifest1',
      options: null as any
    })).rejects.toThrow(RequestValidationError);
  });

  it('should reject if manifest is not found in database', async () => {
    vi.mocked(prisma.migrationManifest.findFirst).mockResolvedValueOnce(null);

    await expect(migrationService.startMigrationJob('user1', 'session1', {
      manifestId: 'non_existent_manifest',
      options: validOptions
    })).rejects.toThrow(ManifestError);
  });
});
