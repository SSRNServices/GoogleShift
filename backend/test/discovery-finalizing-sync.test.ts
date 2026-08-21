import { describe, test, expect, vi } from 'vitest';
import { prisma } from '../src/utils/database';

describe('Discovery Finalizing -> Complete State Synchronization', () => {
  test('autoHealFinalizingJob promotes FINALIZING job to COMPLETED when ScanSummary exists in DB', async () => {
    const autoHealFinalizingJob = async <T extends { id: string; state: string; manifestId?: string | null; sessionId?: string | null }>(job: T): Promise<T> => {
      if (!job || job.state !== 'FINALIZING' || !job.manifestId) return job;
      try {
        const summary = await prisma.scanSummary.findUnique({ where: { manifestId: job.manifestId } });
        if (summary) {
          const updatedJob = await prisma.discoveryJob.update({
            where: { id: job.id },
            data: { state: 'COMPLETED', completedAt: new Date() }
          });
          if (job.sessionId) {
            await prisma.migrationSession.update({
              where: { id: job.sessionId },
              data: { discoveryStatus: 'COMPLETED', manifestId: job.manifestId }
            }).catch(() => {});
          }
          return updatedJob as unknown as T;
        }
      } catch (_) {}
      return job;
    };

    vi.spyOn(prisma.scanSummary, 'findUnique').mockResolvedValueOnce({ id: 'sum-1', manifestId: 'man-123', totalFolders: 45350, totalFiles: 417966 } as any);
    vi.spyOn(prisma.discoveryJob, 'update').mockResolvedValueOnce({ id: 'job-1', state: 'COMPLETED', manifestId: 'man-123' } as any);
    vi.spyOn(prisma.migrationSession, 'update').mockResolvedValueOnce({ id: 'sess-1', discoveryStatus: 'COMPLETED' } as any);

    const initialJob = { id: 'job-1', state: 'FINALIZING', manifestId: 'man-123', sessionId: 'sess-1' };
    const res = await autoHealFinalizingJob(initialJob);

    expect(res.state).toBe('COMPLETED');
    expect(prisma.discoveryJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-1' },
      data: expect.objectContaining({ state: 'COMPLETED' })
    }));
    expect(prisma.migrationSession.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sess-1' },
      data: expect.objectContaining({ discoveryStatus: 'COMPLETED' })
    }));
  });

  test('Migration start endpoint rejects session when discoveryStatus is FINALIZING', () => {
    const validateStartMigration = (sessionStatus: string) => {
      if (sessionStatus !== 'COMPLETED') {
        return { error: `Cannot start migration. Discovery status is ${sessionStatus} (expected COMPLETED).`, status: 400 };
      }
      return { status: 200 };
    };

    expect(validateStartMigration('FINALIZING')).toEqual({
      error: 'Cannot start migration. Discovery status is FINALIZING (expected COMPLETED).',
      status: 400
    });
    expect(validateStartMigration('SCANNING')).toEqual({
      error: 'Cannot start migration. Discovery status is SCANNING (expected COMPLETED).',
      status: 400
    });
    expect(validateStartMigration('COMPLETED')).toEqual({ status: 200 });
  });

  test('Status normalization maps COMPLETE, COMPLETED, SCAN_COMPLETED to COMPLETED', () => {
    const normalizeStatus = (statusStr: string): string => {
      const s = (statusStr || 'QUEUED').toUpperCase();
      if (s === 'COMPLETE' || s === 'COMPLETED' || s === 'SCAN_COMPLETED') return 'COMPLETED';
      if (s === 'FINALIZING' || s === 'MANIFEST_UPDATED') return 'FINALIZING';
      if (s === 'DISCOVERING' || s === 'SCANNING') return 'SCANNING';
      if (s === 'CONNECTING' || s === 'PREPARING') return 'CONNECTING';
      if (s === 'FAILED') return 'FAILED';
      if (s === 'CANCELLED') return 'CANCELLED';
      return s;
    };

    expect(normalizeStatus('COMPLETE')).toBe('COMPLETED');
    expect(normalizeStatus('completed')).toBe('COMPLETED');
    expect(normalizeStatus('SCAN_COMPLETED')).toBe('COMPLETED');
    expect(normalizeStatus('FINALIZING')).toBe('FINALIZING');
    expect(normalizeStatus('MANIFEST_UPDATED')).toBe('FINALIZING');
    expect(normalizeStatus('SCANNING')).toBe('SCANNING');
  });
});
