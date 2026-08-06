import { describe, it, expect, vi, beforeEach } from 'vitest';
import discoveryRouter from '../src/routes/discovery.routes';
import { prisma } from '../src/utils/database';
import { discoveryWorker } from '../src/services/DiscoveryWorker';

vi.mock('../src/utils/database', () => ({
  prisma: {
    migrationSession: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    discoveryJob: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn()
    },
    scanSummary: {
      findUnique: vi.fn(),
      upsert: vi.fn()
    }
  }
}));

vi.mock('../src/services/DiscoveryWorker', () => ({
  discoveryWorker: {
    executeDiscovery: vi.fn().mockResolvedValue(undefined),
    resumePendingJobs: vi.fn().mockResolvedValue(undefined)
  }
}));

describe('Discovery Workflow Test Suite (Phases 1-13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockReqRes = (body: any = {}, params: any = {}, query: any = {}, headers: any = {}) => {
    const req: any = {
      body,
      params,
      query,
      headers,
      user: { id: 'test-user-id', email: 'test@example.com' }
    };

    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn()
    };

    return { req, res };
  };

  const getRouteHandler = (method: string, path: string) => {
    const route = discoveryRouter.stack.find(
      (layer: any) => layer.route && layer.route.path === path && layer.route.methods[method]
    );
    if (!route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
    return route.route.stack[route.route.stack.length - 1].handle;
  };

  it('1. First migration discovery job creation creates job via upsert and returns jobId', async () => {
    const handler = getRouteHandler('post', '/start');

    vi.mocked(prisma.migrationSession.findUnique).mockResolvedValue({
      id: 'session-1',
      ownerId: 'test-user-id',
      sourceAccountId: 'source-acc-1',
      destinationAccountId: 'dest-acc-1'
    } as any);

    vi.mocked(prisma.discoveryJob.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.discoveryJob.upsert).mockResolvedValue({
      id: 'disc-job-1',
      ownerId: 'test-user-id',
      sessionId: 'session-1',
      manifestId: 'manifest_123',
      itemsParam: 'folder1:folder',
      state: 'QUEUED',
      foldersFound: 0,
      filesFound: 0,
      bytesFound: BigInt(0)
    } as any);

    const { req, res } = createMockReqRes({ itemsParam: 'folder1:folder', sessionId: 'session-1' });
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'disc-job-1' }));
    expect(prisma.discoveryJob.upsert).toHaveBeenCalled();
    expect(discoveryWorker.executeDiscovery).toHaveBeenCalled();
  });

  it('2. Resumes active discovery job if one is already running for session', async () => {
    const handler = getRouteHandler('post', '/start');

    vi.mocked(prisma.migrationSession.findUnique).mockResolvedValue({
      id: 'session-1',
      ownerId: 'test-user-id'
    } as any);

    vi.mocked(prisma.discoveryJob.findUnique).mockResolvedValue({
      id: 'active-job-1',
      ownerId: 'test-user-id',
      sessionId: 'session-1',
      state: 'PREPARING',
      lastHeartbeat: new Date()
    } as any);

    const { req, res } = createMockReqRes({ itemsParam: 'folder1:folder', sessionId: 'session-1' });
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'active-job-1', status: 'preparing' }));
    expect(prisma.discoveryJob.upsert).not.toHaveBeenCalled();
  });

  it('3. REST details status endpoint returns structured job status by jobId', async () => {
    const handler = getRouteHandler('get', '/:jobId/details');

    vi.mocked(prisma.discoveryJob.findUnique).mockResolvedValue({
      id: 'disc-job-1',
      sessionId: 'session-1',
      state: 'PREPARING',
      foldersFound: 5,
      filesFound: 25,
      bytesFound: BigInt(1024),
      startedAt: new Date(Date.now() - 5000)
    } as any);

    const { req, res } = createMockReqRes({}, { jobId: 'disc-job-1' });
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'disc-job-1', status: 'preparing', foldersFound: 5, filesFound: 25 }));
  });

  it('4. REST details status endpoint falls back to sessionId lookup if jobId not found directly', async () => {
    const handler = getRouteHandler('get', '/:jobId/details');

    vi.mocked(prisma.discoveryJob.findUnique)
      .mockResolvedValueOnce(null) // first lookup by id
      .mockResolvedValueOnce({
        id: 'disc-job-from-session',
        sessionId: 'session-123',
        state: 'COMPLETED',
        foldersFound: 10,
        filesFound: 50,
        bytesFound: BigInt(2048)
      } as any);

    const { req, res } = createMockReqRes({}, { jobId: 'session-123' });
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'disc-job-from-session', status: 'completed' }));
  });

  it('5. Status endpoint returns HTTP 404 with JOB_NOT_FOUND code for non-existent jobs', async () => {
    const handler = getRouteHandler('get', '/:jobId/details');

    vi.mocked(prisma.discoveryJob.findUnique).mockResolvedValue(null);

    const { req, res } = createMockReqRes({}, { jobId: 'non-existent-job-id' });
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'JOB_NOT_FOUND', message: 'Discovery job does not exist.' }));
  });

  it('6. Handles start discovery request for non-existent session safely with 404', async () => {
    const handler = getRouteHandler('post', '/start');

    vi.mocked(prisma.migrationSession.findUnique).mockResolvedValue(null);

    const { req, res } = createMockReqRes({ itemsParam: 'folder1:folder', sessionId: 'bad-session-id' });
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SESSION' }));
  });

  it('7. Handles rapid restart / retry discovery requests idempotently', async () => {
    const handler = getRouteHandler('post', '/start');

    vi.mocked(prisma.migrationSession.findUnique).mockResolvedValue({
      id: 'session-retry',
      ownerId: 'test-user-id'
    } as any);

    vi.mocked(prisma.discoveryJob.findUnique).mockResolvedValue({
      id: 'disc-retry-1',
      sessionId: 'session-retry',
      state: 'QUEUED',
      lastHeartbeat: new Date()
    } as any);

    const { req: req1, res: res1 } = createMockReqRes({ itemsParam: 'f1:folder', sessionId: 'session-retry' });
    const { req: req2, res: res2 } = createMockReqRes({ itemsParam: 'f1:folder', sessionId: 'session-retry' });

    await handler(req1, res1);
    await handler(req2, res2);

    expect(res1.status).toHaveBeenCalledWith(200);
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(res1.json).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'disc-retry-1' }));
    expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'disc-retry-1' }));
  });
});
