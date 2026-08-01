import 'dotenv/config';
import fs from 'fs';
import path from 'path';
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

export const prisma = global.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

const EXPECTED_SCHEMA: Record<string, string[]> = {
  OAuthAccount: [
    'id', 'userId', 'provider', 'providerAccountId', 'email', 
    'googleAccountId', 'accessToken', 'refreshToken', 'expiresAt', 
    'scopes', 'tokenVersion', 'createdAt', 'updatedAt'
  ],
  User: [
    'id', 'googleId', 'email', 'name', 'avatar', 'role', 'status', 
    'isActive', 'passwordHash', 'createdBy', 'timezone', 'createdAt', 
    'updatedAt', 'lastLogin'
  ],
  MigrationJob: [
    'id', 'ownerId', 'sessionId', 'manifestId', 'state', 'sourceEmail', 
    'destinationEmail', 'sourceFolderId', 'destinationFolderId', 
    'totalFolders', 'totalFiles', 'completedFiles', 'failedFiles', 
    'totalBytes', 'transferredBytes', 'speed', 'eta', 'currentAction', 
    'currentFile', 'currentFolder', 'startedAt', 'completedAt', 'cancelledAt'
  ],
  DiscoveryJob: [
    'id', 'ownerId', 'sessionId', 'manifestId', 'state', 'sourceEmail', 
    'itemsParam', 'foldersFound', 'filesFound', 'bytesFound', 'currentFolder', 
    'currentFile', 'startedAt', 'completedAt', 'cancelledAt'
  ],
  MigrationSession: [
    'id', 'ownerId', 'sourceEmail', 'destinationEmail', 'sourceAccountId', 
    'destinationAccountId', 'sourceFolderId', 'destinationFolderId', 
    'manifestId', 'discoveryStatus', 'migrationStatus', 'statistics', 
    'createdAt', 'updatedAt'
  ],
  session: ['sid', 'sess', 'expire'],
  MigrationManifest: [
    'id', 'jobId', 'sourceId', 'sourceParentId', 'destParentId', 
    'createdDestId', 'name', 'mimeType', 'size', 'originalId', 
    'originalMimeType', 'status', 'isFolder', 'depth', 'retryCount'
  ],
  ScanSummary: [
    'id', 'manifestId', 'totalFolders', 'totalFiles', 'totalBytes', 
    'destinationStorageLimit', 'destinationStorageUsed', 
    'estimatedTimeSeconds', 'largestFile', 'createdAt'
  ]
};

export async function validateDatabaseSchema(): Promise<void> {
  console.log('\n=== Performing Database Schema Validation ===');
  
  // 1. Audit Migrations
  let appliedMigrationNames: string[] = [];
  try {
    const rawMigrations: Array<{ migration_name: string; finished_at: Date | null }> = await prisma.$queryRaw`
      SELECT migration_name, finished_at 
      FROM _prisma_migrations 
      WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL
      ORDER BY finished_at ASC
    `;
    appliedMigrationNames = rawMigrations.map(m => m.migration_name);
  } catch (err) {
    console.warn('⚠️ Could not query _prisma_migrations table:', err);
  }

  const migrationsDir = path.join(process.cwd(), 'prisma', 'migrations');
  let expectedMigrations: string[] = [];
  if (fs.existsSync(migrationsDir)) {
    expectedMigrations = fs.readdirSync(migrationsDir)
      .filter(item => fs.statSync(path.join(migrationsDir, item)).isDirectory())
      .sort();
  }

  const appliedSet = new Set(appliedMigrationNames);
  const pendingMigrations = expectedMigrations.filter(m => !appliedSet.has(m));
  const latestApplied = appliedMigrationNames.length > 0 ? appliedMigrationNames[appliedMigrationNames.length - 1] : 'None';

  console.log(`  - Database Schema Version (Latest Migration): ${latestApplied}`);
  console.log(`  - Applied Migrations (${appliedMigrationNames.length}): ${appliedMigrationNames.join(', ') || 'None'}`);
  console.log(`  - Expected Migrations (${expectedMigrations.length}): ${expectedMigrations.join(', ') || 'None'}`);
  
  if (pendingMigrations.length > 0) {
    console.error(`  - Pending Migrations (${pendingMigrations.length}): ${pendingMigrations.join(', ')}`);
  } else {
    console.log(`  - Pending Migrations: None (Schema up to date)`);
  }

  // 2. Audit Columns
  const columnsRaw: Array<{ table_name: string; column_name: string }> = await prisma.$queryRaw`
    SELECT table_name, column_name 
    FROM information_schema.columns 
    WHERE table_schema = 'public'
  `;

  const dbMap: Record<string, Set<string>> = {};
  for (const row of columnsRaw) {
    const table = row.table_name;
    if (!dbMap[table]) dbMap[table] = new Set();
    dbMap[table].add(row.column_name);
  }

  let mismatchCount = 0;
  const missingColumnsReport: string[] = [];

  for (const [table, expectedColumns] of Object.entries(EXPECTED_SCHEMA)) {
    const existingColumns = dbMap[table];
    if (!existingColumns) {
      console.error(`❌ Missing table in database: ${table}`);
      console.error(`   Migration required: Run 'npx prisma migrate deploy'`);
      mismatchCount++;
      continue;
    }

    for (const col of expectedColumns) {
      if (!existingColumns.has(col)) {
        const msg = `${table}.${col}`;
        missingColumnsReport.push(msg);
        console.error(`❌ Database Schema Mismatch Detected!`);
        console.error(`   Table: ${table}`);
        console.error(`   Expected column: ${table}.${col}`);
        console.error(`   Missing column: ${col}`);
        console.error(`   Migration required: Run 'npx prisma migrate deploy'`);
        mismatchCount++;
      }
    }
  }

  if (mismatchCount > 0 || pendingMigrations.length > 0) {
    console.error(`\n[FATAL] Startup aborted due to database schema mismatch or pending migrations.`);
    console.error(`[FATAL] Missing Columns (${missingColumnsReport.length}): ${missingColumnsReport.join(', ') || 'None'}`);
    console.error(`[FATAL] Pending Migrations (${pendingMigrations.length}): ${pendingMigrations.join(', ') || 'None'}`);
    console.error(`[FATAL] Run 'npx prisma migrate deploy' to sync database schema.\n`);
    process.exit(1);
  }

  console.log('✓ Database Schema Validation Passed - All required models, columns, and migrations are present.\n');
}

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  await pool.end();
  process.exit(0);
});

// getDb removed

export async function createJob(jobId: string, payload: any, ownerId: string) {
  // Assume stats are pre-calculated or default to 0 for now
  await prisma.migrationJob.create({
    data: {
      id: jobId,
      ownerId,
      state: MigrationState.QUEUED,
      sourceEmail: payload.sourceEmail || '',
      destinationEmail: payload.destinationEmail || '',
      sourceFolderId: payload.sourceSelection?.[0]?.id || '',
      destinationFolderId: payload.destinationFolder?.id || '',
      sessionId: payload.sessionId || null,
      manifestId: payload.manifestId || null,
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
    'preparing': MigrationState.PREPARING,
    'copying': MigrationState.COPYING,
    'verifying': MigrationState.VERIFYING,
    'paused': MigrationState.PAUSED,
    'completed': MigrationState.COMPLETED,
    'failed': MigrationState.FAILED,
    'cancelled': MigrationState.CANCELLED
  };

  await prisma.migrationJob.update({
    where: { id: jobId },
    data: { state: stateMap[status.toLowerCase()] || MigrationState.COPYING }
  });
}

export async function logJobEvent(jobId: string, message: string, level: string = 'info', metadata?: any) {
  try {
    await prisma.migrationLog.create({
      data: {
        jobId,
        message,
        level,
        metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : null
      }
    });
  } catch (e) {
    console.error(`Failed to write log for ${jobId}: ${message}`, e);
  }
}

export async function updateJobProgress(jobId: string, updates: any) {
  const data: any = {};
  if (updates.completedFiles !== undefined) data.completedFiles = updates.completedFiles;
  if (updates.failedFiles !== undefined) data.failedFiles = updates.failedFiles;
  if (updates.transferredBytes !== undefined) data.transferredBytes = updates.transferredBytes;
  if (updates.totalFiles !== undefined) data.totalFiles = updates.totalFiles;
  if (updates.totalFolders !== undefined) data.totalFolders = updates.totalFolders;
  if (updates.totalBytes !== undefined) data.totalBytes = updates.totalBytes;
  if (updates.currentAction !== undefined) data.currentAction = updates.currentAction;
  if (updates.speed !== undefined) data.speed = updates.speed;
  if (updates.eta !== undefined) data.eta = updates.eta;
  if (updates.currentFile !== undefined) data.currentFile = updates.currentFile;
  if (updates.currentFolder !== undefined) data.currentFolder = updates.currentFolder;

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
