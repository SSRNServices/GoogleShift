import { prisma, logJobEvent } from '../utils/database';
import { ManifestStorage } from '../utils/ManifestStorage';
import { destinationShardManager } from '../transfer/DestinationShardManager';
import { GoogleDriveErrorClassifier } from '../utils/GoogleDriveErrorClassifier';
import { NetworkClient } from '../transfer/NetworkClient';

export interface RepairReport {
  jobId: string;
  totalFailedScanned: number;
  structurallyBlockedItemsFound: number;
  shardsCreatedOrReused: number;
  itemsRequeued: number;
  details: Array<{
    sourceFolderId: string;
    shardName: string;
    shardDestinationFolderId: string;
    requeuedFilesCount: number;
  }>;
}

export class MigrationRepairService {
  /**
   * Repair an existing partially completed or failed migration job.
   * Identifies items blocked by DESTINATION_FOLDER_CHILD_LIMIT, creates shards,
   * reroutes items, and requeues them without losing existing progress or recreating files.
   */
  public static async repairMigration(jobId: string, ownerId: string): Promise<RepairReport> {
    console.log(`[MigrationRepairService] Starting repair for Job ID: ${jobId}`);

    const job = await prisma.migrationJob.findUnique({
      where: { id: jobId },
      include: { session: true }
    });

    if (!job) {
      throw new Error(`Migration job ${jobId} not found`);
    }

    if (job.ownerId !== ownerId) {
      throw new Error(`Unauthorized access to migration job ${jobId}`);
    }

    const manifestId = job.manifestId || jobId;

    // Obtain destination Google Drive client
    const destDrive = await NetworkClient.getDriveClient(ownerId, 'destination');
    if (!destDrive) {
      throw new Error('Destination account authentication missing or expired');
    }

    // Hydrate existing shards from DB
    await destinationShardManager.loadShards(jobId, manifestId);

    // Get all FAILED items from SQLite manifest
    const failedItems = await ManifestStorage.getFailedItems(manifestId);
    console.log(`[MigrationRepairService] Scanned ${failedItems.length} FAILED items for job ${jobId}`);

    // Get failure error map from Prisma MigrationItem table
    const dbFailedItems = await prisma.migrationItem.findMany({
      where: { jobId, status: 'FAILED' }
    });
    const errorMap = new Map<string, string>();
    for (const item of dbFailedItems) {
      if (item.error) errorMap.set(item.fileId, item.error);
    }

    // Group items affected by DESTINATION_FOLDER_CHILD_LIMIT by sourceParentId & destParentId
    const folderGroup = new Map<string, { sourceParentId: string; destParentId: string; itemIds: string[] }>();
    let structurallyBlockedCount = 0;

    for (const item of failedItems) {
      const rawError = errorMap.get(item.id) || (item as any).error || '';
      const classified = GoogleDriveErrorClassifier.classify({ message: rawError });

      const isFolderLimitError =
        classified.classification === 'DESTINATION_FOLDER_CHILD_LIMIT' ||
        rawError.includes('numChildrenInNonRootLimitExceeded') ||
        rawError.includes('limit for this folder\'s number of children') ||
        rawError.includes('Destination Folder Limit Exceeded') ||
        rawError.includes('Retry count exhausted'); // Repair retry-exhausted items targeting full folders

      if (isFolderLimitError && item.sourceParentId) {
        structurallyBlockedCount++;
        const key = `${item.sourceParentId}:${item.destParentId || 'root'}`;
        if (!folderGroup.has(key)) {
          folderGroup.set(key, {
            sourceParentId: item.sourceParentId,
            destParentId: item.destParentId || 'root',
            itemIds: []
          });
        }
        folderGroup.get(key)!.itemIds.push(item.id);
      }
    }

    console.log(`[MigrationRepairService] Found ${structurallyBlockedCount} structurally blocked items across ${folderGroup.size} folder groups`);

    const folderCache = await ManifestStorage.getFolderCache(manifestId);
    const details: RepairReport['details'] = [];
    let totalRequeued = 0;

    for (const [_, group] of folderGroup) {
      try {
        const shard = await destinationShardManager.getOrCreateShard(
          jobId,
          manifestId,
          destDrive,
          {
            sourceFolderId: group.sourceParentId,
            sourceFolderName: 'Folder',
            originalDestinationFolderId: group.destParentId,
            parentDestinationFolderId: folderCache.get('root_dest') || 'root'
          }
        );

        const requeuedCount = await ManifestStorage.resetFailedItemsForResharding(
          manifestId,
          group.itemIds,
          shard.shardDestinationFolderId
        );

        totalRequeued += requeuedCount;

        details.push({
          sourceFolderId: group.sourceParentId,
          shardName: shard.shardName,
          shardDestinationFolderId: shard.shardDestinationFolderId,
          requeuedFilesCount: requeuedCount
        });
      } catch (e: any) {
        console.error(`[MigrationRepairService] Shard repair error for folder ${group.sourceParentId}: ${e.message}`);
      }
    }

    // Sync stats back to MigrationJob in DB
    const updatedStats = await ManifestStorage.getSummaryStats(manifestId);
    await prisma.migrationJob.update({
      where: { id: jobId },
      data: {
        failedFiles: updatedStats.failedFiles,
        completedFiles: updatedStats.completedFiles,
        state: 'PAUSED', // Set to PAUSED so user can click Resume
        currentAction: `Repaired ${totalRequeued} items into shard folders. Ready to resume.`
      }
    });

    await logJobEvent(
      jobId,
      `[REPAIR] Repaired ${totalRequeued} failed files across ${details.length} destination shards.`
    );

    return {
      jobId,
      totalFailedScanned: failedItems.length,
      structurallyBlockedItemsFound: structurallyBlockedCount,
      shardsCreatedOrReused: details.length,
      itemsRequeued: totalRequeued,
      details
    };
  }
}
