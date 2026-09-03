import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { PrismaClient, MigrationState, ItemStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { safeSerialize, safeDeserialize } from './serialization';
import { MigrationJob, MigrationRequest } from '../transfer/types';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const envVarNames = [
  'DATABASE_URL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL',
  'SUPABASE_DB_URL',
  'POSTGRES_URL_NON_POOLING',
  'DIRECT_URL',
  'SUPABASE_DIRECT_URL'
];

let selectedVarName = '';
let connectionStringRaw = '';

for (const name of envVarNames) {
  if (process.env[name]) {
    selectedVarName = name;
    connectionStringRaw = process.env[name] || '';
    break;
  }
}

const parseHost = (rawUrl: string) => {
  if (!rawUrl) return 'NOT SET';
  try {
    const match = rawUrl.match(/^(?:pg(?:sql|sqlfdw|stream)?|postgres(?:ql)?):\/\/(?:([^:]+):([^@]+)@)?([^:\/\?]+)(?::(\d+))?(\/[^?\s]*)?/);
    if (match) {
      const user = match[1] ? match[1].substring(0, 3) + '***' : '***';
      const host = match[3] || 'unknown';
      const port = match[4] || '5432';
      const db = match[5] || '/postgres';
      return `postgres://${user}:***@${host}:${port}${db}`;
    }
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.username ? parsed.username.substring(0, 3) + '***' : '***'}@${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch (_) {
    return 'Unparseable URL string';
  }
};

export interface DatabaseConnectionInfo {
  variableName: string;
  host: string;
  port: string;
  database: string;
  sslMode: string;
  isPooler: boolean;
  maskedUrl: string;
}

export function getDatabaseConnectionInfo(): DatabaseConnectionInfo {
  let host = 'unknown';
  let port = '5432';
  let database = 'postgres';
  let sslMode = 'prefer';
  let isPooler = false;

  try {
    const parsed = new URL(connectionStringRaw);
    host = parsed.hostname || 'unknown';
    port = parsed.port || '5432';
    database = parsed.pathname.replace('/', '') || 'postgres';
    sslMode = parsed.searchParams.get('sslmode') || 'prefer';
    isPooler = port === '6543' || host.includes('pooler');
  } catch (_) {}

  return {
    variableName: selectedVarName,
    host,
    port,
    database,
    sslMode,
    isPooler,
    maskedUrl: parseHost(connectionStringRaw)
  };
}

console.log('\n=== Database Connection Diagnostic Environment ===');
for (const name of envVarNames) {
  const val = process.env[name];
  console.log(`- ${name}: ${val ? parseHost(val) : 'NOT SET'}`);
}
console.log(`=> Selected Connection Variable: ${selectedVarName || 'NONE'}`);
console.log('==================================================\n');

const connectionString = connectionStringRaw;
const isLocalHost = /127\.0\.0\.1|localhost|googleshift-db/.test(connectionStringRaw);
const isExplicitSslDisable = connectionStringRaw.includes('sslmode=disable');
const isExplicitSslEnable = connectionStringRaw.includes('sslmode=require') || connectionStringRaw.includes('sslmode=verify-full');

const useSsl = isExplicitSslEnable || (!isExplicitSslDisable && !isLocalHost);

// Cap pg.Pool max connections at 10 to stay safely below Supabase/PG limits
export const pool = new Pool({
  connectionString,
  max: 10,
  min: 0,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: false,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

// Handle idle or background client connection errors without crashing Node process
pool.on('error', (err) => {
  console.error('⚠️ [pg.Pool Idle/Background Client Error]:', err.message);
});

const adapter = new PrismaPg(pool);

if (!globalForPrisma.prisma) {
  console.log('[DB] Opening Prisma Singleton client with pg adapter (max connections: 10)');
} else {
  console.log('[DB] Using Existing Prisma Client Singleton instance');
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: ['error', 'warn']
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export async function performWriteDiagnostics(): Promise<void> {
  console.log('\n=== Executing Startup Write Diagnostics ===');
  
  // 1. Check Session & Replica Status via pg.Pool
  try {
    const res = await pool.query(`
      SELECT 
        current_setting('transaction_read_only') AS tx_ro,
        current_setting('default_transaction_read_only') AS def_tx_ro,
        pg_is_in_recovery() AS is_recovery,
        current_user AS curr_user,
        session_user AS sess_user,
        current_database() AS curr_db,
        inet_server_addr() AS server_addr
    `);
    const row = res.rows[0];
    console.log(`[pg.Pool Diagnostics]`);
    console.log(`  - Database Host IP: ${row.server_addr || 'N/A'}`);
    console.log(`  - Current Database: ${row.curr_db}`);
    console.log(`  - Connected User / Session User: ${row.curr_user} / ${row.sess_user}`);
    console.log(`  - Physical Read Replica (pg_is_in_recovery): ${row.is_recovery}`);
    console.log(`  - transaction_read_only: ${row.tx_ro}`);
    console.log(`  - default_transaction_read_only: ${row.def_tx_ro}`);

    if (row.is_recovery) {
      console.error(`❌ [FATAL] Connected to a Physical Read Replica host! Write operations will fail.`);
    }
  } catch (err: any) {
    console.error(`❌ [pg.Pool Status Error]: ${err.message}`);
  }

  // 2. Test Write capability via raw pg.Pool
  try {
    await pool.query('CREATE TEMP TABLE __pg_write_test(id int);');
    await pool.query('INSERT INTO __pg_write_test VALUES (1);');
    await pool.query('UPDATE __pg_write_test SET id=2;');
    await pool.query('DROP TABLE __pg_write_test;');
    console.log('✓ [pg.Pool Write Test] PASSED (CREATE, INSERT, UPDATE, DROP temp table succeeded)');
  } catch (err: any) {
    console.error(`❌ [pg.Pool Write Test FAILED]: ${err.message} (Code: ${err.code})`);
  }

  // 3. Test Write capability via PrismaClient
  try {
    await prisma.$executeRawUnsafe('CREATE TEMP TABLE __prisma_write_test(id int);');
    await prisma.$executeRawUnsafe('INSERT INTO __prisma_write_test VALUES (1);');
    await prisma.$executeRawUnsafe('UPDATE __prisma_write_test SET id=2;');
    await prisma.$executeRawUnsafe('DROP TABLE __prisma_write_test;');
    console.log('✓ [Prisma Write Test] PASSED (CREATE, INSERT, UPDATE, DROP temp table succeeded)');
  } catch (err: any) {
    console.error(`❌ [Prisma Write Test FAILED]: ${err.message} (Code: ${err.code})`);
  }
  console.log('=============================================\n');
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
    'serviceType', 'photosCount', 'videosCount', 'albumsCount', 
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
    'manifestId', 'serviceType', 'discoveryStatus', 'migrationStatus', 'statistics', 
    'createdAt', 'updatedAt'
  ],
  session: ['sid', 'sess', 'expire'],
  ScanSummary: [
    'id', 'manifestId', 'totalFolders', 'totalFiles', 'totalBytes', 
    'destinationStorageLimit', 'destinationStorageUsed', 
    'estimatedTimeSeconds', 'largestFile', 'createdAt'
  ],
  PhotosPickerSession: [
    'id', 'pickerSessionId', 'pickerUri', 'userId', 'sourceAccountId', 
    'migrationJobId', 'manifestId', 'status', 'mediaItemsSet', 'selectedCount', 
    'photosCount', 'videosCount', 'totalBytes', 'expiresAt', 'createdAt', 'updatedAt'
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

  // 2. Self-Healing Enums & Columns Check
  try {
    // ServiceType Enum & Columns
    await pool.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ServiceType') THEN 
          CREATE TYPE "ServiceType" AS ENUM ('DRIVE', 'PHOTOS'); 
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'MigrationJob' AND column_name = 'serviceType'
        ) THEN
          ALTER TABLE "MigrationJob" ADD COLUMN "serviceType" "ServiceType" NOT NULL DEFAULT 'DRIVE';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'MigrationJob' AND column_name = 'photosCount'
        ) THEN
          ALTER TABLE "MigrationJob" ADD COLUMN "photosCount" INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE "MigrationJob" ADD COLUMN "videosCount" INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE "MigrationJob" ADD COLUMN "albumsCount" INTEGER NOT NULL DEFAULT 0;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'MigrationSession' AND column_name = 'serviceType'
        ) THEN
          ALTER TABLE "MigrationSession" ADD COLUMN "serviceType" "ServiceType" NOT NULL DEFAULT 'DRIVE';
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'PhotosPickerSession') AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'PhotosPickerSession' AND column_name = 'manifestId'
        ) THEN
          ALTER TABLE "PhotosPickerSession" ADD COLUMN "manifestId" TEXT;
        END IF;
      END $$;
    `);
    console.log('  - Schema Integrity: ServiceType enum & counter columns verified/self-healed.');
  } catch (healErr: any) {
    console.warn('⚠️ Self-healing schema query error:', healErr.message);
  }

  // 3. Audit Enum Types (DiscoveryState)
  try {
    const enumRaw: Array<{ typname: string }> = await prisma.$queryRaw`
      SELECT typname FROM pg_type WHERE typname = 'DiscoveryState'
    `;
    if (enumRaw.length === 0) {
      console.warn(`⚠️ Missing enum type DiscoveryState. Attempting self-healing DDL query...`);
      try {
        await pool.query(`
          DO $$ 
          BEGIN 
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DiscoveryState') THEN 
              CREATE TYPE "DiscoveryState" AS ENUM ('CREATED', 'QUEUED', 'CONNECTING', 'DISCOVERING', 'SCANNING', 'FINALIZING', 'COMPLETED', 'FAILED', 'CANCELLED'); 
            END IF; 
          END $$;

          ALTER TABLE "DiscoveryJob" ALTER COLUMN "state" DROP DEFAULT;

          ALTER TABLE "DiscoveryJob" ALTER COLUMN "state" TYPE "DiscoveryState" USING (
            CASE 
              WHEN "state"::text = 'PREPARING' THEN 'CONNECTING'::"DiscoveryState"
              WHEN "state"::text = 'COPYING' THEN 'SCANNING'::"DiscoveryState"
              WHEN "state"::text = 'VERIFYING' THEN 'FINALIZING'::"DiscoveryState"
              WHEN "state"::text = 'PAUSED' THEN 'QUEUED'::"DiscoveryState"
              WHEN "state"::text IN ('CREATED', 'QUEUED', 'CONNECTING', 'DISCOVERING', 'SCANNING', 'FINALIZING', 'COMPLETED', 'FAILED', 'CANCELLED') THEN "state"::text::"DiscoveryState"
              ELSE 'QUEUED'::"DiscoveryState"
            END
          );

          ALTER TABLE "DiscoveryJob" ALTER COLUMN "state" SET DEFAULT 'QUEUED';
        `);
        console.log(`✓ Self-healing DDL query created DiscoveryState enum successfully.`);
      } catch (ddlErr: any) {
        console.error(`❌ Could not auto-create DiscoveryState enum: ${ddlErr.message}`);
      }
    } else {
      console.log(`  - Enum Check: DiscoveryState exists in PostgreSQL schema.`);
    }
  } catch (err: any) {
    console.warn('⚠️ Could not query pg_type for DiscoveryState enum:', err.message);
  }

  // 4. Audit Columns against EXPECTED_SCHEMA
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
    console.error(`\n❌ [DATABASE SCHEMA MISMATCH DETECTED]`);
    if (missingColumnsReport.length > 0) {
      console.error(`❌ Missing Required Database Columns (${missingColumnsReport.length}): ${missingColumnsReport.join(', ')}`);
    }
    if (pendingMigrations.length > 0) {
      console.error(`❌ Pending Prisma Migrations (${pendingMigrations.length}): ${pendingMigrations.join(', ')}`);
    }
    throw new Error(`DATABASE SCHEMA MISMATCH: Incompatible PostgreSQL schema. Missing columns: ${missingColumnsReport.join(', ')}. Pending migrations: ${pendingMigrations.join(', ')}.`);
  } else {
    console.log('✓ Database Schema Validation Passed - All required models, columns, enums, and migrations are verified.\n');
  }
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

export async function saveCheckpoint(
  jobId: string,
  type: 'folder' | 'file',
  folderId: string,
  fileId: string,
  status: string,
  metadata?: { fileName?: string; mimeType?: string; size?: number; error?: string }
) {
  const itemStatusMap: Record<string, ItemStatus> = {
    'pending': ItemStatus.PENDING,
    'queued': ItemStatus.QUEUED,
    'downloading': ItemStatus.DOWNLOADING,
    'uploading': ItemStatus.UPLOADING,
    'success': ItemStatus.SUCCESS,
    'failed': ItemStatus.FAILED
  };

  const itemStatus = itemStatusMap[status.toLowerCase()] || ItemStatus.PENDING;

  await prisma.migrationItem.upsert({
    where: { jobId_fileId: { jobId, fileId: fileId || folderId } },
    update: {
      status: itemStatus,
      ...(metadata?.fileName ? { fileName: metadata.fileName } : {}),
      ...(metadata?.mimeType ? { mimeType: metadata.mimeType } : {}),
      ...(metadata?.size !== undefined ? { size: BigInt(metadata.size) } : {}),
      ...(metadata?.error ? { error: metadata.error } : {})
    },
    create: {
      jobId,
      fileId: fileId || folderId,
      status: itemStatus,
      fileName: metadata?.fileName,
      mimeType: metadata?.mimeType,
      size: metadata?.size !== undefined ? BigInt(metadata.size) : BigInt(0),
      error: metadata?.error
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
