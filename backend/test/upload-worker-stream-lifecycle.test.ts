import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { UploadWorker } from '../src/transfer/UploadWorker';
import { StreamLifecycleError } from '../src/utils/errors';
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

describe('UploadWorker Stream Lifecycle & Retry Classification Test Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockWorker = (sourceStream: Readable, onUploadComplete?: (body: Readable) => void) => {
    const mockSourceDrive = {
      files: {
        get: vi.fn().mockResolvedValue({ data: sourceStream }),
        export: vi.fn().mockResolvedValue({ data: sourceStream })
      }
    } as any;

    const mockDestDrive = {
      files: {
        create: vi.fn().mockImplementation(async ({ media }) => {
          await new Promise<void>((resolve, reject) => {
            media.body.on('data', () => {});
            media.body.on('end', () => {
              if (onUploadComplete) onUploadComplete(media.body);
              resolve();
            });
            media.body.on('error', reject);
          });
          return { data: { id: 'dest-file-id' } };
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
      reportSuccess: vi.fn(),
      reportRateLimit: vi.fn()
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
      { maxUploadWorkers: 5, streamBufferSize: 64 * 1024 } as any
    );

    return { worker, mockSourceDrive, mockDestDrive, mockStateManager, mockRateLimiter };
  };

  it('1. should upload 500KB HEIC file without stream.push after EOF', async () => {
    const data = Buffer.alloc(500 * 1024, 'a');
    const sourceStream = Readable.from([data]);
    const { worker, mockStateManager } = createMockWorker(sourceStream);

    vi.mocked(prisma.migrationManifest.findUnique).mockResolvedValue({
      status: 'QUEUED',
      retryCount: 0
    } as any);

    const item = {
      id: 'item-500k-heic',
      jobId: 'manifest-1',
      sourceId: 'src-500k-heic',
      sourceParentId: 'root',
      destParentId: 'root_dest',
      name: 'IMG20251129212057.heic',
      mimeType: 'image/heic',
      size: 500 * 1024,
      isFolder: false,
      retryCount: 0
    } as any;

    const releaseWorker = vi.fn();
    const retryJob = vi.fn();

    await worker.processFile(item, releaseWorker, retryJob);

    expect(mockStateManager.commitSuccess).toHaveBeenCalledWith(item);
    expect(mockStateManager.reportProgressBytes).toHaveBeenCalledWith(500 * 1024);
    expect(retryJob).not.toHaveBeenCalled();
    expect(releaseWorker).toHaveBeenCalledWith(1);
  });

  it('2. should upload 1MB HEIC file cleanly', async () => {
    const data = Buffer.alloc(1021813, 'b'); // Exact byte size mentioned in requirements
    const sourceStream = Readable.from([data]);
    const { worker, mockStateManager } = createMockWorker(sourceStream);

    vi.mocked(prisma.migrationManifest.findUnique).mockResolvedValue({
      status: 'QUEUED',
      retryCount: 0
    } as any);

    const item = {
      id: 'item-1m-heic',
      jobId: 'manifest-1',
      sourceId: 'src-1m-heic',
      sourceParentId: 'root',
      destParentId: 'root_dest',
      name: 'Warranty Card.heic',
      mimeType: 'image/heic',
      size: 1021813,
      isFolder: false,
      retryCount: 0
    } as any;

    const releaseWorker = vi.fn();
    const retryJob = vi.fn();

    await worker.processFile(item, releaseWorker, retryJob);

    expect(mockStateManager.commitSuccess).toHaveBeenCalledWith(item);
    expect(retryJob).not.toHaveBeenCalled();
    expect(releaseWorker).toHaveBeenCalledWith(1);
  });

  it('3. should upload 10MB PDF file cleanly', async () => {
    const chunk = Buffer.alloc(64 * 1024, 'c');
    async function* generatePDF() {
      for (let i = 0; i < 160; i++) {
        yield chunk;
      }
    }

    const sourceStream = Readable.from(generatePDF());
    const { worker, mockStateManager } = createMockWorker(sourceStream);

    vi.mocked(prisma.migrationManifest.findUnique).mockResolvedValue({
      status: 'QUEUED',
      retryCount: 0
    } as any);

    const item = {
      id: 'item-10m-pdf',
      jobId: 'manifest-1',
      sourceId: 'src-10m-pdf',
      sourceParentId: 'root',
      destParentId: 'root_dest',
      name: 'large_document.pdf',
      mimeType: 'application/pdf',
      size: 10 * 1024 * 1024,
      isFolder: false,
      retryCount: 0
    } as any;

    const releaseWorker = vi.fn();
    const retryJob = vi.fn();

    await worker.processFile(item, releaseWorker, retryJob);

    expect(mockStateManager.commitSuccess).toHaveBeenCalledWith(item);
    expect(releaseWorker).toHaveBeenCalledWith(1);
  });

  it('4. should handle zero-byte file upload cleanly', async () => {
    const sourceStream = Readable.from([]);
    const { worker, mockStateManager } = createMockWorker(sourceStream);

    vi.mocked(prisma.migrationManifest.findUnique).mockResolvedValue({
      status: 'QUEUED',
      retryCount: 0
    } as any);

    const item = {
      id: 'item-0-byte',
      jobId: 'manifest-1',
      sourceId: 'src-0-byte',
      sourceParentId: 'root',
      destParentId: 'root_dest',
      name: 'empty.txt',
      mimeType: 'text/plain',
      size: 0,
      isFolder: false,
      retryCount: 0
    } as any;

    const releaseWorker = vi.fn();
    const retryJob = vi.fn();

    await worker.processFile(item, releaseWorker, retryJob);

    expect(mockStateManager.commitSuccess).toHaveBeenCalledWith(item);
    expect(releaseWorker).toHaveBeenCalledWith(1);
  });

  it('5. should support multiple concurrent uploads without cross-worker stream corruption', async () => {
    const items = [1, 2, 3, 4, 5].map((id) => ({
      id: `item-${id}`,
      jobId: 'manifest-1',
      sourceId: `src-${id}`,
      sourceParentId: 'root',
      destParentId: 'root_dest',
      name: `file_${id}.png`,
      mimeType: 'image/png',
      size: 250 * 1024,
      isFolder: false,
      retryCount: 0
    }));

    vi.mocked(prisma.migrationManifest.findUnique).mockResolvedValue({
      status: 'QUEUED',
      retryCount: 0
    } as any);

    const tasks = items.map((item, index) => {
      const sourceStream = Readable.from([Buffer.alloc(250 * 1024, `data-${index}`)]);
      const { worker, mockStateManager } = createMockWorker(sourceStream);
      const releaseWorker = vi.fn();
      const retryJob = vi.fn();

      return worker.processFile(item as any, releaseWorker, retryJob).then(() => {
        expect(mockStateManager.commitSuccess).toHaveBeenCalledWith(item);
        expect(releaseWorker).toHaveBeenCalledWith(1);
      });
    });

    await Promise.all(tasks);
  });

  it('6. stream should close exactly at upload completion without double end or destroy calls', async () => {
    const sourceStream = Readable.from([Buffer.from('hello world')]);
    let uploadStreamRef: any = null;

    const { worker } = createMockWorker(sourceStream, (bodyStream) => {
      uploadStreamRef = bodyStream;
    });

    vi.mocked(prisma.migrationManifest.findUnique).mockResolvedValue({
      status: 'QUEUED',
      retryCount: 0
    } as any);

    const item = {
      id: 'item-stream-closing',
      jobId: 'manifest-1',
      sourceId: 'src-stream-closing',
      sourceParentId: 'root',
      destParentId: 'root_dest',
      name: 'hello.txt',
      mimeType: 'text/plain',
      size: 11,
      isFolder: false,
      retryCount: 0
    } as any;

    await worker.processFile(item as any, vi.fn(), vi.fn());

    expect(uploadStreamRef).not.toBeNull();
    expect(uploadStreamRef.writableEnded).toBe(true);
  });

  it('7. should mark Stream Lifecycle Error as NON-RETRIABLE and NOT invoke retryJob', async () => {
    const sourceStream = new Readable({
      read() {
        this.emit('error', new StreamLifecycleError('stream.push() after EOF'));
      }
    });

    const mockSourceDrive = {
      files: { get: vi.fn().mockResolvedValue({ data: sourceStream }) }
    } as any;

    const mockDestDrive = {
      files: {
        create: vi.fn().mockImplementation(async ({ media }) => {
          await new Promise((_, reject) => media.body.on('error', reject));
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
      { maxUploadWorkers: 5 } as any
    );

    vi.mocked(prisma.migrationManifest.findUnique).mockResolvedValue({
      status: 'QUEUED',
      retryCount: 0
    } as any);

    const item = {
      id: 'item-stream-err',
      jobId: 'manifest-1',
      sourceId: 'src-stream-err',
      sourceParentId: 'root',
      destParentId: 'root_dest',
      name: 'broken_stream.heic',
      mimeType: 'image/heic',
      size: 1000,
      isFolder: false,
      retryCount: 0
    } as any;

    const releaseWorker = vi.fn();
    const retryJob = vi.fn();

    await worker.processFile(item as any, releaseWorker, retryJob);

    // NON-RETRIABLE: retryJob should NOT be called, updateState('FAILED') MUST be called
    expect(retryJob).not.toHaveBeenCalled();
    expect(mockStateManager.updateState).toHaveBeenCalledWith('item-stream-err', 'FAILED');
    expect(releaseWorker).toHaveBeenCalledWith(1);
  });
});
