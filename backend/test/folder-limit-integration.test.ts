import { describe, it, expect } from 'vitest';
import { GoogleDriveErrorClassifier } from '../src/utils/GoogleDriveErrorClassifier';
import { destinationShardManager } from '../src/transfer/DestinationShardManager';
import { destinationFolderGuard } from '../src/transfer/DestinationFolderGuard';

describe('Folder Limit Integration & Sharding Workflow', () => {
  const jobId = 'test-job-folder-limit-integration';
  const manifestId = 'test-manifest-folder-limit-integration';
  const sourceFolderId = 'source-large-folder';
  const fullDestFolderId = 'dest-full-folder-999';

  it('full integration workflow: 403 numChildrenInNonRootLimitExceeded -> classify -> block -> shard -> upload', async () => {
    let shardDriveCreateCalls = 0;
    const mockDestDrive: any = {
      files: {
        create: async (params: any) => {
          const parent = params.requestBody.parents?.[0];
          // If uploading to full folder -> return 403 numChildrenInNonRootLimitExceeded
          if (parent === fullDestFolderId) {
            const err: any = new Error("The limit for this folder's number of children (files and folders) has been exceeded.");
            err.response = {
              status: 403,
              data: {
                error: {
                  errors: [{ reason: 'numChildrenInNonRootLimitExceeded' }],
                  code: 403,
                  message: "The limit for this folder's number of children (files and folders) has been exceeded."
                }
              }
            };
            throw err;
          }

          // Otherwise (creating shard or uploading to shard) -> succeed
          shardDriveCreateCalls++;
          return {
            data: {
              id: `shard-folder-${shardDriveCreateCalls}`,
              name: params.requestBody.name
            }
          };
        }
      }
    };

    // Step 1: Simulate worker upload attempt into full destination folder
    let caughtError: any = null;
    try {
      await mockDestDrive.files.create({
        requestBody: { name: 'stars.js', parents: [fullDestFolderId] }
      });
    } catch (e: any) {
      caughtError = e;
    }

    expect(caughtError).not.toBeNull();

    // Step 2: Classify error
    const classified = GoogleDriveErrorClassifier.classify(caughtError, {
      operation: 'files.create',
      sourceFolderId,
      destinationFolderId: fullDestFolderId
    });

    expect(classified.classification).toBe('DESTINATION_FOLDER_CHILD_LIMIT');
    expect(classified.retryable).toBe(false);

    // Step 3: Trigger shard creation
    const shard = await destinationShardManager.getOrCreateShard(jobId, manifestId, mockDestDrive, {
      sourceFolderId,
      sourceFolderName: 'SourceFolder',
      originalDestinationFolderId: fullDestFolderId,
      parentDestinationFolderId: 'root'
    });

    expect(shard).toBeDefined();
    expect(shard.shardNumber).toBe(1);
    expect(shard.shardName).toContain('Migration Part 001');

    // Step 4: Verify destination folder is marked blocked
    expect(destinationFolderGuard.isBlocked(jobId, fullDestFolderId)).toBe(true);

    // Step 5: Retry file upload into shard folder
    const retryRes = await mockDestDrive.files.create({
      requestBody: { name: 'stars.js', parents: [shard.shardDestinationFolderId] }
    });

    expect(retryRes.data.id).toBeDefined();

    // Step 6: Subsequent file check -> resolves directly to shard folder
    const activeDestId = destinationShardManager.resolveActiveDestinationFolderId(
      jobId,
      sourceFolderId,
      fullDestFolderId
    );

    expect(activeDestId).toBe(shard.shardDestinationFolderId);
    expect(activeDestId).not.toBe(fullDestFolderId);
  });
});
