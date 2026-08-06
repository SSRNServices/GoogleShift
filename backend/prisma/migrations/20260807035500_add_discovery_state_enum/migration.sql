-- CreateEnum safely
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DiscoveryState') THEN 
    CREATE TYPE "DiscoveryState" AS ENUM ('CREATED', 'QUEUED', 'CONNECTING', 'DISCOVERING', 'SCANNING', 'FINALIZING', 'COMPLETED', 'FAILED', 'CANCELLED'); 
  END IF; 
END $$;

-- AlterTable safely with legacy MigrationState value mapping
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
