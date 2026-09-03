-- CreateEnum (if not exists)
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ServiceType') THEN 
        CREATE TYPE "ServiceType" AS ENUM ('DRIVE', 'PHOTOS'); 
    END IF; 
END $$;

-- AlterTable MigrationJob
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "serviceType" "ServiceType" NOT NULL DEFAULT 'DRIVE';
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "photosCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "videosCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MigrationJob" ADD COLUMN IF NOT EXISTS "albumsCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable MigrationSession
ALTER TABLE "MigrationSession" ADD COLUMN IF NOT EXISTS "serviceType" "ServiceType" NOT NULL DEFAULT 'DRIVE';
