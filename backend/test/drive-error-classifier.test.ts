import { describe, it, expect } from 'vitest';
import { GoogleDriveErrorClassifier } from '../src/utils/GoogleDriveErrorClassifier';
import { classifyError, DestinationFolderChildLimitError, UploadError } from '../src/utils/errors';

describe('GoogleDriveErrorClassifier', () => {
  it('1. should classify 403 numChildrenInNonRootLimitExceeded as DESTINATION_FOLDER_CHILD_LIMIT and non-retryable', () => {
    const errorResponse = {
      response: {
        status: 403,
        data: {
          error: {
            errors: [
              {
                domain: 'global',
                reason: 'numChildrenInNonRootLimitExceeded',
                message: "The limit for this folder's number of children (files and folders) has been exceeded."
              }
            ],
            code: 403,
            message: "The limit for this folder's number of children (files and folders) has been exceeded."
          }
        }
      }
    };

    const classified = GoogleDriveErrorClassifier.classify(errorResponse, {
      operation: 'files.create',
      destinationFolderId: 'dest-folder-123'
    });

    expect(classified.classification).toBe('DESTINATION_FOLDER_CHILD_LIMIT');
    expect(classified.retryable).toBe(false);
    expect(classified.httpStatus).toBe(403);
    expect(classified.googleReason).toBe('numChildrenInNonRootLimitExceeded');
  });

  it('2. should classify 403 rateLimitExceeded as RATE_LIMIT and retryable', () => {
    const errorResponse = {
      response: {
        status: 403,
        data: {
          error: {
            errors: [{ reason: 'rateLimitExceeded', message: 'User Rate Limit Exceeded' }],
            code: 403
          }
        }
      }
    };

    const classified = GoogleDriveErrorClassifier.classify(errorResponse);
    expect(classified.classification).toBe('RATE_LIMIT');
    expect(classified.retryable).toBe(true);
  });

  it('3. should classify 403 storageQuotaExceeded as STORAGE_LIMIT and non-retryable', () => {
    const errorResponse = {
      response: {
        status: 403,
        data: {
          error: {
            errors: [{ reason: 'storageQuotaExceeded', message: 'Storage quota exceeded' }]
          }
        }
      }
    };

    const classified = GoogleDriveErrorClassifier.classify(errorResponse);
    expect(classified.classification).toBe('STORAGE_LIMIT');
    expect(classified.retryable).toBe(false);
  });

  it('4. should classify 401 as AUTHENTICATION_FAILURE', () => {
    const errorResponse = {
      response: { status: 401, data: { error: { message: 'Invalid Credentials' } } }
    };

    const classified = GoogleDriveErrorClassifier.classify(errorResponse);
    expect(classified.classification).toBe('AUTHENTICATION_FAILURE');
    expect(classified.retryable).toBe(false);
  });

  it('5. should classify stream errors as STREAM_INTERRUPTED', () => {
    const error = new Error('ERR_STREAM_PUSH_AFTER_EOF: push() after EOF');
    const classified = GoogleDriveErrorClassifier.classify(error);
    expect(classified.classification).toBe('STREAM_INTERRUPTED');
    expect(classified.retryable).toBe(false);
  });

  it('6. should classify network errors as NETWORK_ERROR and retryable', () => {
    const error = { code: 'ECONNRESET', message: 'read ECONNRESET' };
    const classified = GoogleDriveErrorClassifier.classify(error);
    expect(classified.classification).toBe('NETWORK_ERROR');
    expect(classified.retryable).toBe(true);
  });

  it('7. classifyError helper should return permanent for DestinationFolderChildLimitError', () => {
    const err = new DestinationFolderChildLimitError('Folder limit exceeded', 'dest-123');
    expect(err.isPermanent).toBe(true);
    expect(err.isRetryable).toBe(false);
    expect(classifyError(err)).toBe('permanent');
  });
});
