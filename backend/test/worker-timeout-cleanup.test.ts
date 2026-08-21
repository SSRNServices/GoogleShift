import { describe, test, expect, vi, beforeEach } from 'vitest';
import { UploadWorker } from '../src/transfer/UploadWorker';
import { AdaptiveRateLimiter } from '../src/transfer/AdaptiveRateLimiter';
import { MigrationStateManager } from '../src/services/MigrationStateManager';
import { ManifestItem } from '../src/utils/ManifestStorage';

describe('UploadWorker Timeout & Cleanup', () => {
  let rateLimiter: AdaptiveRateLimiter;
  let stateManager: MigrationStateManager;
  let folderCache: Map<string, string>;
  let mockSourceDrive: any;
  let mockDestDrive: any;

  beforeEach(() => {
    rateLimiter = new AdaptiveRateLimiter(16, 2, 20);
    stateManager = new MigrationStateManager('test-job', 'test-manifest');
    folderCache = new Map<string, string>([['root', 'dest-root-id']]);

    mockSourceDrive = {
      files: {
        get: vi.fn(),
        export: vi.fn()
      }
    };
    mockDestDrive = {
      files: {
        create: vi.fn(),
        get: vi.fn()
      }
    };
  });

  test('Worker is released in finally block even when download throws an exception', async () => {
    const worker = new UploadWorker(
      1,
      'test-job',
      'test-manifest',
      mockSourceDrive,
      mockDestDrive,
      rateLimiter,
      stateManager,
      {},
      folderCache,
      { maxUploadWorkers: 16 }
    );

    mockSourceDrive.files.get.mockRejectedValue(new Error('Network socket reset'));

    let workerReleased = false;
    const releaseCallback = (id: number) => {
      expect(id).toBe(1);
      workerReleased = true;
    };

    const item: ManifestItem = {
      id: 'file-1',
      jobId: 'test-job',
      sourceId: 'src-file-1',
      sourceParentId: 'root',
      destParentId: 'dest-root-id',
      createdDestId: null,
      name: 'test.avi',
      mimeType: 'video/x-msvideo',
      size: 50 * 1024 * 1024,
      originalId: null,
      originalMimeType: null,
      status: 'QUEUED',
      isFolder: false,
      depth: 0,
      retryCount: 0
    };

    const retryJobMock = vi.fn().mockResolvedValue(undefined);

    await worker.processFile(item, releaseCallback, retryJobMock);

    expect(workerReleased).toBe(true);
    expect(worker.isBusy).toBe(false);
    expect(worker.currentFile).toBeNull();
    expect(retryJobMock).toHaveBeenCalledWith(item);
  });

  test('Worker is released when item is already SUCCESS or FAILED', async () => {
    const worker = new UploadWorker(
      2,
      'test-job',
      'test-manifest',
      mockSourceDrive,
      mockDestDrive,
      rateLimiter,
      stateManager,
      {},
      folderCache,
      { maxUploadWorkers: 16 }
    );

    let released = false;
    const item: ManifestItem = {
      id: 'file-2',
      jobId: 'test-job',
      sourceId: 'src-2',
      sourceParentId: 'root',
      destParentId: 'dest-root-id',
      createdDestId: 'dest-2',
      name: 'done.png',
      mimeType: 'image/png',
      size: 100,
      originalId: null,
      originalMimeType: null,
      status: 'SUCCESS',
      isFolder: false,
      depth: 0,
      retryCount: 0
    };

    await worker.processFile(item, () => { released = true; }, vi.fn());

    expect(released).toBe(true);
    expect(worker.isBusy).toBe(false);
    expect(mockSourceDrive.files.get).not.toHaveBeenCalled();
  });
});
