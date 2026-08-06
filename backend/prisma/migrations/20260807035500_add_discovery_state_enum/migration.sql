-- CreateEnum safely
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DiscoveryState') THEN 
    CREATE TYPE "DiscoveryState" AS ENUM ('CREATED', 'QUEUED', 'CONNECTING', 'DISCOVERING', 'SCANNING', 'FINALIZING', 'COMPLETED', 'FAILED', 'CANCELLED'); 
  END IF; 
END $$;

-- AlterTable safely
ALTER TABLE "DiscoveryJob" ALTER COLUMN "state" DROP DEFAULT;
ALTER TABLE "DiscoveryJob" ALTER COLUMN "state" TYPE "DiscoveryState" USING ("state"::text::"DiscoveryState");
ALTER TABLE "DiscoveryJob" ALTER COLUMN "state" SET DEFAULT 'QUEUED';
