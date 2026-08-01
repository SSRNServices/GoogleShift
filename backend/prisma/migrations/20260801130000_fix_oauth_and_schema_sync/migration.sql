-- AlterEnum
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPERVISOR';

-- AlterEnum
ALTER TYPE "MigrationState" ADD VALUE IF NOT EXISTS 'PREPARING';
ALTER TYPE "MigrationState" ADD VALUE IF NOT EXISTS 'COPYING';
ALTER TYPE "MigrationState" ADD VALUE IF NOT EXISTS 'VERIFYING';

-- AlterTable User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "createdBy" TEXT;

-- AlterTable OAuthAccount
ALTER TABLE "OAuthAccount" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "OAuthAccount" ADD COLUMN IF NOT EXISTS "googleAccountId" TEXT;
ALTER TABLE "OAuthAccount" ADD COLUMN IF NOT EXISTS "scopes" TEXT;
ALTER TABLE "OAuthAccount" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "OAuthAccount" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "OAuthAccount" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex for OAuthAccount
CREATE INDEX IF NOT EXISTS "OAuthAccount_userId_idx" ON "OAuthAccount"("userId");

-- AlterTable MigrationJob
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "sourceEmail" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "destinationEmail" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "sourceFolderId" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "destinationFolderId" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "totalFolders" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "currentAction" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "currentFile" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "currentFolder" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "MigrationJob_sessionId_key" ON "MigrationJob"("sessionId");

-- CreateTable MigrationSession
CREATE TABLE IF NOT EXISTS "MigrationSession" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "sourceEmail" TEXT,
    "destinationEmail" TEXT,
    "sourceAccountId" TEXT,
    "destinationAccountId" TEXT,
    "sourceFolderId" TEXT,
    "destinationFolderId" TEXT,
    "manifestId" TEXT,
    "discoveryStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "migrationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "statistics" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MigrationSession_ownerId_idx" ON "MigrationSession"("ownerId");

-- AddForeignKey MigrationJob to MigrationSession
ALTER TABLE "MigrationJob" DROP CONSTRAINT IF EXISTS "MigrationJob_sessionId_fkey";
ALTER TABLE "MigrationJob" ADD CONSTRAINT "MigrationJob_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MigrationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable DiscoveryJob
CREATE TABLE IF NOT EXISTS "DiscoveryJob" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "sessionId" TEXT,
    "manifestId" TEXT NOT NULL,
    "state" "MigrationState" NOT NULL DEFAULT 'QUEUED',
    "sourceEmail" TEXT,
    "itemsParam" TEXT,
    "foldersFound" INTEGER NOT NULL DEFAULT 0,
    "filesFound" INTEGER NOT NULL DEFAULT 0,
    "bytesFound" BIGINT NOT NULL DEFAULT 0,
    "currentFolder" TEXT,
    "currentFile" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "DiscoveryJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DiscoveryJob_sessionId_key" ON "DiscoveryJob"("sessionId");
CREATE UNIQUE INDEX IF NOT EXISTS "DiscoveryJob_manifestId_key" ON "DiscoveryJob"("manifestId");
CREATE INDEX IF NOT EXISTS "DiscoveryJob_ownerId_idx" ON "DiscoveryJob"("ownerId");
CREATE INDEX IF NOT EXISTS "DiscoveryJob_state_idx" ON "DiscoveryJob"("state");

-- CreateTable MigrationLog
CREATE TABLE IF NOT EXISTS "MigrationLog" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MigrationLog_jobId_idx" ON "MigrationLog"("jobId");
CREATE INDEX IF NOT EXISTS "MigrationLog_createdAt_idx" ON "MigrationLog"("createdAt");

-- CreateTable session
CREATE TABLE IF NOT EXISTS "session" (
    "sid" VARCHAR NOT NULL,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

-- CreateTable MigrationManifest
CREATE TABLE IF NOT EXISTS "MigrationManifest" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceParentId" TEXT,
    "destParentId" TEXT,
    "createdDestId" TEXT,
    "name" TEXT,
    "mimeType" TEXT,
    "size" BIGINT NOT NULL DEFAULT 0,
    "originalId" TEXT,
    "originalMimeType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "isFolder" BOOLEAN NOT NULL DEFAULT false,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MigrationManifest_pkey" PRIMARY KEY ("jobId","id")
);
CREATE INDEX IF NOT EXISTS "MigrationManifest_jobId_status_idx" ON "MigrationManifest"("jobId", "status");
CREATE INDEX IF NOT EXISTS "MigrationManifest_jobId_sourceParentId_idx" ON "MigrationManifest"("jobId", "sourceParentId");

-- CreateTable ScanSummary
CREATE TABLE IF NOT EXISTS "ScanSummary" (
    "id" TEXT NOT NULL,
    "manifestId" TEXT NOT NULL,
    "totalFolders" INTEGER NOT NULL DEFAULT 0,
    "totalFiles" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "destinationStorageLimit" BIGINT NOT NULL DEFAULT 0,
    "destinationStorageUsed" BIGINT NOT NULL DEFAULT 0,
    "estimatedTimeSeconds" INTEGER NOT NULL DEFAULT 0,
    "largestFile" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanSummary_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ScanSummary_manifestId_key" ON "ScanSummary"("manifestId");

-- CreateTable MimeStats
CREATE TABLE IF NOT EXISTS "MimeStats" (
    "id" TEXT NOT NULL,
    "summaryId" TEXT NOT NULL,
    "googleDocs" INTEGER NOT NULL DEFAULT 0,
    "googleSheets" INTEGER NOT NULL DEFAULT 0,
    "googleSlides" INTEGER NOT NULL DEFAULT 0,
    "pdf" INTEGER NOT NULL DEFAULT 0,
    "images" INTEGER NOT NULL DEFAULT 0,
    "videos" INTEGER NOT NULL DEFAULT 0,
    "archives" INTEGER NOT NULL DEFAULT 0,
    "unsupported" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "other" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MimeStats_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MimeStats_summaryId_key" ON "MimeStats"("summaryId");

-- CreateTable ScanWarning
CREATE TABLE IF NOT EXISTS "ScanWarning" (
    "id" TEXT NOT NULL,
    "summaryId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "fileId" TEXT,
    "fileName" TEXT,

    CONSTRAINT "ScanWarning_pkey" PRIMARY KEY ("id")
);

-- Foreign Keys
ALTER TABLE "MigrationSession" DROP CONSTRAINT IF EXISTS "MigrationSession_ownerId_fkey";
ALTER TABLE "MigrationSession" ADD CONSTRAINT "MigrationSession_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiscoveryJob" DROP CONSTRAINT IF EXISTS "DiscoveryJob_ownerId_fkey";
ALTER TABLE "DiscoveryJob" ADD CONSTRAINT "DiscoveryJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiscoveryJob" DROP CONSTRAINT IF EXISTS "DiscoveryJob_sessionId_fkey";
ALTER TABLE "DiscoveryJob" ADD CONSTRAINT "DiscoveryJob_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MigrationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MigrationLog" DROP CONSTRAINT IF EXISTS "MigrationLog_jobId_fkey";
ALTER TABLE "MigrationLog" ADD CONSTRAINT "MigrationLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "MigrationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MimeStats" DROP CONSTRAINT IF EXISTS "MimeStats_summaryId_fkey";
ALTER TABLE "MimeStats" ADD CONSTRAINT "MimeStats_summaryId_fkey" FOREIGN KEY ("summaryId") REFERENCES "ScanSummary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScanWarning" DROP CONSTRAINT IF EXISTS "ScanWarning_summaryId_fkey";
ALTER TABLE "ScanWarning" ADD CONSTRAINT "ScanWarning_summaryId_fkey" FOREIGN KEY ("summaryId") REFERENCES "ScanSummary"("id") ON DELETE CASCADE ON UPDATE CASCADE;
