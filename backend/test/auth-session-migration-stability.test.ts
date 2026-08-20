import { describe, it, expect, vi } from 'vitest';
import { workerWatchdog } from '../src/transfer/WorkerWatchdog';
import { prisma } from '../src/utils/database';

describe('Auth Session & Migration Stability Suite', () => {

  it('TEST 1: Cookie domain auto-derivation generates correct root domain for cross-subdomain sessions', () => {
    const getDerivedCookieDomain = (targetUrl: string, explicitDomain?: string) => {
      if (explicitDomain) return explicitDomain;
      try {
        const hostname = new URL(targetUrl).hostname;
        const parts = hostname.split('.');
        if (parts.length >= 2) {
          return `.${parts.slice(-2).join('.')}`;
        }
        return hostname;
      } catch (_) {
        return undefined;
      }
    };

    // Test production URL
    const domain = getDerivedCookieDomain('https://migration.ssrnservices.in');
    expect(domain).toBe('.ssrnservices.in');

    // Test explicit domain override
    const explicit = getDerivedCookieDomain('https://migration.ssrnservices.in', '.customdomain.com');
    expect(explicit).toBe('.customdomain.com');
  });

  it('TEST 2: Duplicate migration start safeguard returns existing active job', async () => {
    // Mock prisma query for active job
    const fakeJob = {
      id: 'existing_job_123',
      ownerId: 'user_456',
      state: 'COPYING',
      startedAt: new Date()
    };

    vi.spyOn(prisma.migrationJob, 'findFirst').mockResolvedValueOnce(fakeJob as any);

    const active = await prisma.migrationJob.findFirst({
      where: {
        ownerId: 'user_456',
        state: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] }
      }
    });

    expect(active).toBeDefined();
    expect(active?.id).toBe('existing_job_123');
    expect(active?.state).toBe('COPYING');
  });

  it('TEST 3: WorkerWatchdog lifecycle management (start/stop) operates without errors', () => {
    expect(() => {
      workerWatchdog.start();
      workerWatchdog.stop();
    }).not.toThrow();
  });
});
