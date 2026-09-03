-- AlterTable MigrationJob add organization column if not exists
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "organization" TEXT DEFAULT 'FLAT';

-- CreateTable PhotosPickerSession
CREATE TABLE IF NOT EXISTS "PhotosPickerSession" (
    "id" TEXT NOT NULL,
    "pickerSessionId" TEXT NOT NULL,
    "pickerUri" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceAccountId" TEXT,
    "migrationJobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "mediaItemsSet" BOOLEAN NOT NULL DEFAULT false,
    "selectedCount" INTEGER NOT NULL DEFAULT 0,
    "photosCount" INTEGER NOT NULL DEFAULT 0,
    "videosCount" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhotosPickerSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PhotosPickerSession_pickerSessionId_key" ON "PhotosPickerSession"("pickerSessionId");
CREATE UNIQUE INDEX IF NOT EXISTS "PhotosPickerSession_migrationJobId_key" ON "PhotosPickerSession"("migrationJobId");
CREATE INDEX IF NOT EXISTS "PhotosPickerSession_userId_idx" ON "PhotosPickerSession"("userId");
CREATE INDEX IF NOT EXISTS "PhotosPickerSession_status_idx" ON "PhotosPickerSession"("status");

-- AddForeignKey
ALTER TABLE "PhotosPickerSession" ADD CONSTRAINT "PhotosPickerSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
