-- AlterTable MigrationSession
ALTER TABLE "MigrationSession" ADD COLUMN IF NOT EXISTS "sourceAccountId" TEXT;
ALTER TABLE "MigrationSession" ADD COLUMN IF NOT EXISTS "destinationAccountId" TEXT;
