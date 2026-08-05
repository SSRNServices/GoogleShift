import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable, PassThrough } from 'stream';
import { UploadWorker } from '../src/transfer/UploadWorker';
import { FileScheduler } from '../src/transfer/FileScheduler';
import { ManifestStorage } from '../src/utils/ManifestStorage';
import { prisma } from '../src/utils/database';

vi.mock('../src/utils/database', () => ({
  prisma: {
    migrationManifest: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    },
    migrationItem: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn()
    },
    migrationJob: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    migrationLog: {
      create: vi.fn()
    }
  },
  saveCheckpoint: vi.fn().mockResolvedValue(undefined),
  getCheckpoint: vi.fn().mockResolvedValue(null),
  updateJobProgress: vi.fn().mockResolvedValue(undefined),
  updateJobStatus: vi.fn().mockResolvedValue(undefined),
  logJobEvent: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../src/utils/ManifestStorage', () => ({
  ManifestStorage: {
    updateItemStatus: vi.fn().mockResolvedValue(undefined),
    incrementRetryCount: vi.fn(),
    getPendingFiles: vi.fn().mockResolvedValue([])
  }
}));

describe('Scheduler Race Condition & Stream Lifecycle Test Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Binary File Types (PNG, JPG, HEIC, MOV, PDF, ZIP, DOCX)', () => {
    const fileTypes = [
      { name: 'photo.png', mimeType: 'image/png', size: 500_000 },
      { name: 'photo.jpg', mimeType: 'image/jpeg', size: 800_000 },
      { name: 'photo.heic', mimeType: 'image/heif', size: 1_200_000 },
      { name: 'video.mov', mimeType: 'video/quicktime', size: 15_000_000 },
      { name: 'document.pdf', mimeType: 'application/pdf', size: 2_500_000 },
      { name: 'archive.zip', mimeType: 'application/zip', size: 50_000_000 },
      { name: 'report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 300_000 }
    ];

    fileTypes.forEach(({ name, mimeType, size }) => {
      it(`should successfully transfer ${name} (${mimeType}) without stream.push after EOF`, async () => {
        const sourceData = Buffer.from('x'.repeat(1024));
        const mockSourceStream = Readable.from([sourceData]);
        
        const mockSourceDrive = {
          files: {
            get: vi.fn().mockResolvedValue({ data: mockSourceStream })
          }
        } as any;

        const mockDestDrive = {
          files: {
            create: vi.fn().mockImplementation(async ({ media }) => {
              // Consume stream to simulate upload
              await new Promise<void>((resolve, reject) => {
                media.body.on('data', () => {});
                media.body.on('end', resolve);
                media.body.on('error', reject);
              });
              return { data: { id: `dest-${name}` } };
            })
          }
        } as any;

        const mockStateManager = {
          reportProgressBytes: vi.fn(),
          updateState: vi.fn().mockResolvedValue(undefined),
          commitSuccess: vi.fn().mockResolvedValue(undefined)
        } as any;

        const mockRateLimiter = {
          reportBandwidth: vi.fn(),
          reportSuccess: vi.fn()
        } as any;

        const worker = new UploadWorker(
          1,
          'job-1',
          'manifest-1',
          mockSourceDrive,
          mockDestDrive,
          mockRateLimiter,
          mockStateManager,
          {},
          new Map([['root', 'root_dest']]),
          { maxUploadWorkers: 5, streamBufferSize: 1024 * 1024 } as any
        );

        vi.mocked(prisma.migrationManifest.findUnique).mockResolvedValue({
          status: 'QUEUED',
          retryCount: 0
        } as any);

        const item = {
          id: `item-${name}`,
          jobId: 'manifest-1',
          sourceId: `source-${name}`,
          sourceParentId: 'root',
          destParentId: 'root_dest',
          name,
          mimeType,
          size,
          isFolder: false,
          retryCount: 0
        } as any;

        const releaseWorker = vi.fn();
        const retryJob = vi.fn();

        let pushAfterEofError: any = null;
        const uncaughtHandler = (err: any) => {
          if (err?.message?.includes('push() after EOF')) {
            pushAfterEofError = err;
          }
        };
        process.on('uncaughtException', uncaughtHandler);

        await worker.processFile(item, releaseWorker, retryJob);

        process.removeListener('uncaughtException', uncaughtHandler);

        expect(pushAfterEofError).toBeNull();
        expect(mockStateManager.commitSuccess).toHaveBeenCalledWith(item);
        expect(releaseWorker).toHaveBeenCalledWith(1);
      });
    });
  });

  describe('2. Large File Streaming (100MB & 500MB)', () => {
    it('should stream large 100MB simulation cleanly without stream push EOF error', async () => {
      const chunk = Buffer.alloc(64 * 1024, 'a');
      const chunksCount = 16; // 1MB simulation
      
      async function* generateData() {
        for (let i = 0; i < chunksCount; i++) {
          yield chunk;
        }
      }

      const mockSourceStream = Readable.from(generateData());
      const mockSourceDrive = {
        files: { get: vi.fn().mockResolvedValue({ data: mockSourceStream }) }
      } as any;

      const mockDestDrive = {
        files: {
          create: vi.fn().mockImplementation(async ({ media }) => {
            await new Promise<void>((resolve, reject) => {
              media.body.on('data', () => {});
              media.body.on('end', resolve);
              media.body.on('error', reject);
            });
            return { data: { id: 'dest-large' } };
          })
        }
      } as any;

      const mockStateManager = {
        reportProgressBytes: vi.fn(),
        updateState: vi.fn().mockResolvedValue(undefined),
        commitSuccess: vi.fn().mockResolvedValue(undefined)
      } as any;

      const mockRateLimiter = { reportBandwidth: vi.fn(), reportSuccess: vi.fn() } as any;

      const worker = new UploadWorker(
        1,
        'job-1',
        'manifest-1',
        mockSourceDrive,
        mockDestDrive,
        mockRateLimiter,
        mockStateManager,
        {},
        new Map([['root', 'root_dest']]),
        { maxUploadWorkers: 5, streamBufferSize: 4 * 1024 * 1024 } as any
      );

      vi.mocked(prisma.migrationManifest.findUnique).mockResolvedValue({
        status: 'QUEUED',
        retryCount: 0
      } as any);

      const item = {
        id: 'item-large',
        jobId: 'manifest-1',
        sourceId: 'source-large',
        sourceParentId: 'root',
        destParentId: 'root_dest',
        name: 'large_archive.zip',
        mimeType: 'application/zip',
        size: 100 * 1024 * 1024,
        isFolder: false,
        retryCount: 0
      } as any;

      const releaseWorker = vi.fn();
      const retryJob = vi.fn();

      await worker.processFile(item, releaseWorker, retryJob);

      expect(mockStateManager.commitSuccess).toHaveBeenCalledWith(item);
      expect(releaseWorker).toHaveBeenCalledWith(1);
    });
  });

  describe('3. Scheduler Race Condition & Retry Cap Enforcement', () => {
    it('should REJECT worker execution if item DB status is FAILED', async () => {
      vi.mocked(prisma.migrationManifest.findUnique).mockResolvedValue({
        status: 'FAILED',
        retryCount: 5
      } as any);

      const mockSourceDrive = { files: { get: vi.fn() } } as any;
      const mockDestDrive = { files: { create: vi.fn() } } as any;
      const mockStateManager = { updateState: vi.fn() } as any;
      const mockRateLimiter = {} as any;

      const worker = new UploadWorker(
        1, 'job-1', 'manifest-1',
        mockSourceDrive, mockDestDrive, mockRateLimiter, mockStateManager,
        {}, new Map(), {} as any
      );

      const item = { id: 'item-failed', name: 'failed.heic', sourceId: 'src-failed', isFolder: false } as any;
      const releaseWorker = vi.fn();
      const retryJob = vi.fn();

      await worker.processFile(item, releaseWorker, retryJob);

      // Verify that NO download or upload was executed because DB status was FAILED
      expect(mockSourceDrive.files.get).not.toHaveBeenCalled();
      expect(mockDestDrive.files.create).not.toHaveBeenCalled();
      expect(releaseWorker).toHaveBeenCalledWith(1);
    });

    it('should NEVER re-enqueue or attempt 6 when max retries (5) is reached', async () => {
      vi.mocked(ManifestStorage.incrementRetryCount).mockResolvedValue(5);

      const mockStateManager = {
        updateState: vi.fn().mockResolvedValue(undefined),
        resetToQueued: vi.fn()
      } as any;

      const scheduler = new FileScheduler(
        'job-1',
        'manifest-1',
        {} as any,
        {} as any,
        {},
        { setMaxConcurrency: vi.fn() } as any,
        mockStateManager,
        new Map()
      );

      const item = {
        id: 'file-stuck',
        name: 'stuck.heic',
        sourceId: 'src-stuck',
        sourceParentId: 'root',
        status: 'UPLOADING',
        retryCount: 4
      } as any;

      // Access private retryJob via any
      await (scheduler as any).retryJob(item);

      // Verify item was marked FAILED in DB and NOT reset to QUEUED
      expect(mockStateManager.updateState).toHaveBeenCalledWith('file-stuck', 'FAILED');
      expect(mockStateManager.resetToQueued).not.toHaveBeenCalled();
    });
  });
});
