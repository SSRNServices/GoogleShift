// @ts-nocheck
import 'dotenv/config';
import { PrismaClient, MigrationState, ItemStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { safeSerialize, safeDeserialize } from './serialization';
import { MigrationJob, MigrationRequest } from '../transfer/types';

declare global {
  var prisma: PrismaClient | undefined;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL?.replace(/\?sslmode=require|&sslmode=require/, ''),
  max: 20,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: false,
  ssl: { rejectUnauthorized: false },
});

const adapter = new PrismaPg(pool);

const prismaClient = global.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prismaClient;
}

export { prismaClient as prisma };

process.on('SIGINT', async () => {
  await prismaClient.$disconnect();
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prismaClient.$disconnect();
  await pool.end();
  process.exit(0);
});

export async function getDb() {
  return {
    run: async (...args: any[]) => ({ changes: 0 }),
    get: async (...args: any[]) => null,
    all: async (...args: any[]) => []
  };
}

export async function createJob(jobId: string, payload: MigrationRequest, ownerId: string) {
  // Assume stats are pre-calculated or default to 0 for now
  await prisma.migrationJob.create({
    data: {
      id: jobId,
      ownerId,
      state: MigrationState.QUEUED,
      sourceEmail: payload.sourceEmail || '',
      destinationEmail: payload.destinationEmail || '',
      sourceFolderId: payload.sourceSelection[0]?.id || '',
      destinationFolderId: payload.destinationFolder?.id || '',
      startedAt: new Date(),
    }
  });
}

export async function getJob(jobId: string): Promise<any | null> {
  const row = await prisma.migrationJob.findUnique({
    where: { id: jobId }
  });
  if (!row) return null;
  
  return {
    jobId: row.id,
    status: row.state.toLowerCase(),
    ownerId: row.ownerId,
    // Add other fields mapped to legacy format
  };
}

export async function updateJobStatus(jobId: string, status: string) {
  const stateMap: Record<string, MigrationState> = {
    'queued': MigrationState.QUEUED,
    'running': MigrationState.RUNNING,
    'paused': MigrationState.PAUSED,
    'completed': MigrationState.COMPLETED,
    'failed': MigrationState.FAILED,
    'cancelled': MigrationState.CANCELLED
  };

  await prisma.migrationJob.update({
    where: { id: jobId },
    data: { state: stateMap[status.toLowerCase()] || MigrationState.RUNNING }
  });
}

export async function logJobEvent(jobId: string, message: string) {
  // Activity or log... simplified for now
}

export async function updateJobProgress(jobId: string, updates: any) {
  const data: any = {};
  if (updates.completedFiles !== undefined) data.completedFiles = updates.completedFiles;
  if (updates.failedFiles !== undefined) data.failedFiles = updates.failedFiles;
  if (updates.transferredBytes !== undefined) data.transferredBytes = updates.transferredBytes;
  if (updates.speed !== undefined) data.speed = updates.speed;
  if (updates.eta !== undefined) data.eta = updates.eta;

  if (Object.keys(data).length > 0) {
    await prisma.migrationJob.update({
      where: { id: jobId },
      data
    });
  }
}

export async function saveCheckpoint(jobId: string, type: 'folder' | 'file', folderId: string, fileId: string, status: string) {
  const itemStatusMap: Record<string, ItemStatus> = {
    'pending': ItemStatus.PENDING,
    'queued': ItemStatus.QUEUED,
    'downloading': ItemStatus.DOWNLOADING,
    'uploading': ItemStatus.UPLOADING,
    'success': ItemStatus.SUCCESS,
    'failed': ItemStatus.FAILED
  };

  await prisma.migrationItem.upsert({
    where: { jobId_fileId: { jobId, fileId: fileId || folderId } },
    update: { status: itemStatusMap[status.toLowerCase()] || ItemStatus.PENDING },
    create: {
      jobId,
      fileId: fileId || folderId,
      status: itemStatusMap[status.toLowerCase()] || ItemStatus.PENDING
    }
  });
}

export async function getCheckpoint(jobId: string, type: 'folder' | 'file', folderId: string, fileId: string): Promise<string | null> {
  const item = await prisma.migrationItem.findUnique({
    where: { jobId_fileId: { jobId, fileId: fileId || folderId } }
  });
  return item ? item.status.toLowerCase() : null;
}

// Auth wrappers
export async function getUserById(id: string) {
  return await prisma.user.findUnique({ where: { id } });
}

export async function getUserByGoogleId(googleId: string) {
  return await prisma.user.findUnique({ where: { googleId } });
}

export async function createUser(profile: any) {
  // Check if it's the first user
  const count = await prisma.user.count();
  const role = count === 0 ? 'SUPER_ADMIN' : 'USER';
  const status = count === 0 ? 'ACTIVE' : 'PENDING';

  return await prisma.user.create({
    data: {
      googleId: profile.id,
      email: profile.emails?.[0]?.value || '',
      name: profile.displayName || '',
      avatar: profile.photos?.[0]?.value || '',
      role,
      status,
    }
  });
}
