import { describe, it, expect, beforeEach } from 'vitest';
import { DestinationShardManager, destinationShardManager } from '../src/transfer/DestinationShardManager';
import { destinationFolderGuard } from '../src/transfer/DestinationFolderGuard';

describe('DestinationShardManager Concurrency', () => {
  const jobId = 'test-job-shard-concurrency';
  const manifestId = 'test-manifest-shard-concurrency';
  const sourceFolderId = 'source-folder-full-123';
  const originalDestFolderId = 'dest-folder-full-456';

  beforeEach(() => {
    destinationFolderGuard.clearJob(jobId);
  });

  it('1. simultaneous worker requests should converge on exactly ONE shard folder', async () => {
    let mockDriveCreateCalls = 0;
    const mockDestDrive: any = {
      files: {
        create: async (params: any) => {
          mockDriveCreateCalls++;
          // Simulate latency
          await new Promise(r => setTimeout(r, 50));
          return {
            data: {
              id: `shard-folder-id-${mockDriveCreateCalls}`,
              name: params.requestBody.name
            }
          };
        }
      }
    };

    // Simulate 10 workers calling getOrCreateShard concurrently
    const workerPromises = Array.from({ length: 10 }).map((_, idx) =>
      destinationShardManager.getOrCreateShard(jobId, manifestId, mockDestDrive, {
        sourceFolderId,
        sourceFolderName: 'Project Files',
        originalDestinationFolderId: originalDestFolderId,
        parentDestinationFolderId: 'root'
      })
    );

    const results = await Promise.all(workerPromises);

    // Verify all 10 workers received a valid shard
    expect(results).toHaveLength(10);

    // Verify exactly ONE shard creation API call was executed
    expect(mockDriveCreateCalls).toBe(1);

    // Verify all 10 workers converged on the SAME shard destination ID
    const firstShardId = results[0].shardDestinationFolderId;
    for (const r of results) {
      expect(r.shardDestinationFolderId).toBe(firstShardId);
      expect(r.shardNumber).toBe(1);
    }
  });
});
