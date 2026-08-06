-- CreateEnum
CREATE TYPE "DiscoveryState" AS ENUM ('CREATED', 'QUEUED', 'CONNECTING', 'DISCOVERING', 'SCANNING', 'FINALIZING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "DiscoveryJob" ALTER COLUMN "state" DROP DEFAULT;
ALTER TABLE "DiscoveryJob" ALTER COLUMN "state" TYPE "DiscoveryState" USING ("state"::text::"DiscoveryState");
ALTER TABLE "DiscoveryJob" ALTER COLUMN "state" SET DEFAULT 'QUEUED';
