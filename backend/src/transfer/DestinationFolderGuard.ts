import { EventEmitter } from 'events';

export interface BlockedFolderInfo {
  destinationFolderId: string;
  sourceFolderId: string;
  reason: string;
  blockedAt: number;
}

export class DestinationFolderGuard {
  private static instance: DestinationFolderGuard;
  
  // jobId -> Set of blocked destinationFolderIds
  private blockedFolders: Map<string, Map<string, BlockedFolderInfo>> = new Map();
  
  // Lock mechanism: key = `jobId:${destinationFolderId}` -> Promise queue / lock
  private locks: Map<string, Promise<void>> = new Map();

  private constructor() {}

  public static getInstance(): DestinationFolderGuard {
    if (!DestinationFolderGuard.instance) {
      DestinationFolderGuard.instance = new DestinationFolderGuard();
    }
    return DestinationFolderGuard.instance;
  }

  /**
   * Acquire an async lock for a specific destination folder in a migration job
   */
  public async acquireLock(jobId: string, destinationFolderId: string): Promise<() => void> {
    const lockKey = `${jobId}:${destinationFolderId}`;
    
    while (this.locks.has(lockKey)) {
      try {
        await this.locks.get(lockKey);
      } catch (_) {}
    }

    let releaseResolver: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });

    this.locks.set(lockKey, lockPromise);

    return () => {
      this.locks.delete(lockKey);
      releaseResolver();
    };
  }

  /**
   * Mark a destination folder as structurally blocked (e.g. child limit reached)
   */
  public markBlocked(jobId: string, destinationFolderId: string, sourceFolderId: string, reason: string): void {
    if (!this.blockedFolders.has(jobId)) {
      this.blockedFolders.set(jobId, new Map());
    }

    const jobMap = this.blockedFolders.get(jobId)!;
    if (!jobMap.has(destinationFolderId)) {
      console.warn(
        `[DestinationFolderGuard] BLOCKED | JobId: ${jobId} | ` +
        `DestinationFolderId: ${destinationFolderId} | SourceFolderId: ${sourceFolderId} | Reason: ${reason}`
      );
      jobMap.set(destinationFolderId, {
        destinationFolderId,
        sourceFolderId,
        reason,
        blockedAt: Date.now()
      });
    }
  }

  /**
   * Check if a destination folder is currently marked as structurally blocked
   */
  public isBlocked(jobId: string, destinationFolderId: string): boolean {
    const jobMap = this.blockedFolders.get(jobId);
    return !!jobMap && jobMap.has(destinationFolderId);
  }

  /**
   * Get blocked info for a folder
   */
  public getBlockedInfo(jobId: string, destinationFolderId: string): BlockedFolderInfo | undefined {
    return this.blockedFolders.get(jobId)?.get(destinationFolderId);
  }

  /**
   * Clear blocked state for a job (e.g. on job completion/cleanup)
   */
  public clearJob(jobId: string): void {
    this.blockedFolders.delete(jobId);
  }
}

export const destinationFolderGuard = DestinationFolderGuard.getInstance();
