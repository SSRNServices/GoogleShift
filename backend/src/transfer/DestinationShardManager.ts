import { drive_v3 } from 'googleapis';
import { destinationFolderGuard } from './DestinationFolderGuard';
import { ManifestStorage } from '../utils/ManifestStorage';
import { prisma } from '../utils/database';

export interface FolderShardInfo {
  jobId: string;
  sourceFolderId: string;
  originalDestinationFolderId: string;
  shardNumber: number;
  shardDestinationFolderId: string;
  shardName: string;
}

export class DestinationShardManager {
  private static instance: DestinationShardManager;

  // In-memory cache: jobId:sourceFolderId -> FolderShardInfo[]
  private shardCache: Map<string, FolderShardInfo[]> = new Map();

  private constructor() {}

  public static getInstance(): DestinationShardManager {
    if (!DestinationShardManager.instance) {
      DestinationShardManager.instance = new DestinationShardManager();
    }
    return DestinationShardManager.instance;
  }

  private getCacheKey(jobId: string, sourceFolderId: string): string {
    return `${jobId}:${sourceFolderId}`;
  }

  /**
   * Hydrate shard mappings from DB/manifest for a job
   */
  public async loadShards(jobId: string, manifestId: string): Promise<void> {
    try {
      // Load from SQLite manifest database
      const dbShards = await ManifestStorage.getFolderShards(manifestId);
      for (const shard of dbShards) {
        const cacheKey = this.getCacheKey(jobId, shard.sourceFolderId);
        if (!this.shardCache.has(cacheKey)) {
          this.shardCache.set(cacheKey, []);
        }
        const list = this.shardCache.get(cacheKey)!;
        if (!list.some(s => s.shardNumber === shard.shardNumber)) {
          list.push(shard);
        }
      }
    } catch (e: any) {
      console.warn(`[DestinationShardManager] Warning loading shards for job ${jobId}: ${e.message}`);
    }
  }

  /**
   * Get latest active shard for a source folder if one exists
   */
  public getActiveShard(jobId: string, sourceFolderId: string): FolderShardInfo | null {
    const cacheKey = this.getCacheKey(jobId, sourceFolderId);
    const shards = this.shardCache.get(cacheKey);
    if (!shards || shards.length === 0) return null;
    return shards[shards.length - 1]; // Latest active shard
  }

  /**
   * Get active destination folder ID for a source folder (returns shard ID if sharded, else original dest ID)
   */
  public resolveActiveDestinationFolderId(jobId: string, sourceFolderId: string, defaultDestId: string): string {
    const activeShard = this.getActiveShard(jobId, sourceFolderId);
    if (activeShard) {
      return activeShard.shardDestinationFolderId;
    }
    return defaultDestId;
  }

  /**
   * Obtain or create a new destination folder shard when a child limit is hit.
   * THREAD-SAFE: Uses per-folder mutex lock via DestinationFolderGuard.
   */
  public async getOrCreateShard(
    jobId: string,
    manifestId: string,
    destDrive: drive_v3.Drive,
    context: {
      sourceFolderId: string;
      sourceFolderName: string;
      originalDestinationFolderId: string;
      parentDestinationFolderId: string;
    }
  ): Promise<FolderShardInfo> {
    const { sourceFolderId, sourceFolderName, originalDestinationFolderId, parentDestinationFolderId } = context;

    // Acquire per-destination-folder lock to prevent duplicate shard creation across concurrent workers
    const releaseLock = await destinationFolderGuard.acquireLock(jobId, originalDestinationFolderId);

    try {
      // 1. Check if another worker created a shard while we were waiting for the lock
      const existingShards = this.shardCache.get(this.getCacheKey(jobId, sourceFolderId)) || [];
      const currentActiveShard = existingShards.length > 0 ? existingShards[existingShards.length - 1] : null;

      // Mark original folder as blocked in guard
      destinationFolderGuard.markBlocked(
        jobId,
        originalDestinationFolderId,
        sourceFolderId,
        'numChildrenInNonRootLimitExceeded'
      );

      if (currentActiveShard) {
        console.log(
          `[DestinationShard] REUSE | JobId: ${jobId} | ` +
          `SourceFolderId: ${sourceFolderId} | ShardNumber: ${currentActiveShard.shardNumber}`
        );
        return currentActiveShard;
      }

      // Determine next shard number
      const nextShardNumber = (existingShards.length > 0) ? existingShards[existingShards.length - 1].shardNumber + 1 : 1;
      const formattedNumber = String(nextShardNumber).padStart(3, '0');
      const shardFolderName = `${sourceFolderName || 'Folder'} - Migration Part ${formattedNumber}`;

      console.log(
        `[DestinationShard] CREATE_START | JobId: ${jobId} | ` +
        `SourceFolder: "${sourceFolderName}" (${sourceFolderId}) | ` +
        `OriginalDestFolder: ${originalDestinationFolderId} | ShardNumber: ${nextShardNumber}`
      );

      // 2. Create the shard folder in destination Google Drive
      // Note: Shard folder is created under parentDestinationFolderId (or root)
      const parentIdForShard = parentDestinationFolderId || originalDestinationFolderId;
      const createRes = await destDrive.files.create({
        requestBody: {
          name: shardFolderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentIdForShard]
        },
        fields: 'id, name, parents'
      });

      if (!createRes.data.id) {
        throw new Error(`Failed to create shard folder "${shardFolderName}" in Google Drive: No ID returned`);
      }

      const shardDestinationFolderId = createRes.data.id;

      const shardInfo: FolderShardInfo = {
        jobId,
        sourceFolderId,
        originalDestinationFolderId,
        shardNumber: nextShardNumber,
        shardDestinationFolderId,
        shardName: shardFolderName
      };

      // 3. Update in-memory cache
      const cacheKey = this.getCacheKey(jobId, sourceFolderId);
      if (!this.shardCache.has(cacheKey)) {
        this.shardCache.set(cacheKey, []);
      }
      this.shardCache.get(cacheKey)!.push(shardInfo);

      // 4. Persist shard mapping in SQLite manifest DB & PostgreSQL Prisma DB
      await ManifestStorage.saveFolderShard(manifestId, shardInfo);
      
      try {
        await prisma.destinationShard.create({
          data: {
            jobId,
            sourceFolderId,
            originalDestinationFolderId,
            shardNumber: nextShardNumber,
            shardDestinationFolderId
          }
        });
      } catch (prismaErr: any) {
        console.warn(`[DestinationShardManager] Prisma shard log warning: ${prismaErr.message}`);
      }

      // 5. Re-route pending files in manifest targeting the full folder to the new shard folder
      const reroutedCount = await ManifestStorage.reroutePendingItemsToShard(
        manifestId,
        originalDestinationFolderId,
        shardDestinationFolderId
      );

      console.log(
        `[DestinationShard] CREATE_SUCCESS | JobId: ${jobId} | ` +
        `ShardName: "${shardFolderName}" | ShardDestFolderId: ${shardDestinationFolderId} | ` +
        `ReroutedFiles: ${reroutedCount}`
      );

      return shardInfo;
    } finally {
      releaseLock();
    }
  }
}

export const destinationShardManager = DestinationShardManager.getInstance();
