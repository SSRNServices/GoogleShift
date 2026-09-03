import { describe, it, expect } from 'vitest';
import { GoogleApiErrorClassifier, PhotosErrorCode } from '../src/utils/GoogleApiErrorClassifier';

describe('GoogleApiErrorClassifier', () => {
  it('should correctly classify API disabled / not used in project error as PHOTOS_API_DISABLED', () => {
    const error = {
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: 'Google Photos Picker API has not been used in project 636862284300 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/photospicker.googleapis.com/overview?project=636862284300 then retry.',
            status: 'PERMISSION_DENIED',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.Help',
                links: [
                  {
                    description: 'Google developers console API activation',
                    url: 'https://console.developers.google.com/apis/api/photospicker.googleapis.com/overview?project=636862284300'
                  }
                ]
              },
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'SERVICE_DISABLED',
                domain: 'googleapis.com',
                metadata: {
                  consumer: 'projects/636862284300',
                  service: 'photospicker.googleapis.com'
                }
              }
            ]
          }
        }
      }
    };

    const classified = GoogleApiErrorClassifier.classify(error);
    expect(classified.code).toBe(PhotosErrorCode.PHOTOS_API_DISABLED);
    expect(classified.statusCode).toBe(403);
    expect(classified.projectId).toBe('636862284300');
    expect(classified.userMessage).toContain('photospicker.googleapis.com');
  });

  it('should classify missing scope error as PHOTOS_AUTH_REQUIRED', () => {
    const error = {
      response: {
        status: 403,
        data: {
          error: {
            message: 'Request had insufficient authentication scopes.',
            status: 'PERMISSION_DENIED'
          }
        }
      }
    };

    const classified = GoogleApiErrorClassifier.classify(error);
    expect(classified.code).toBe(PhotosErrorCode.PHOTOS_AUTH_REQUIRED);
    expect(classified.statusCode).toBe(403);
  });

  it('should classify 401 invalid_grant as PHOTOS_TOKEN_EXPIRED', () => {
    const error = {
      response: {
        status: 401,
        data: {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.'
        }
      }
    };

    const classified = GoogleApiErrorClassifier.classify(error);
    expect(classified.code).toBe(PhotosErrorCode.PHOTOS_TOKEN_EXPIRED);
    expect(classified.statusCode).toBe(401);
  });

  it('should classify 429 rate limit error as PHOTOS_RATE_LIMITED', () => {
    const error = {
      response: {
        status: 429,
        data: {
          error: {
            message: 'Rate limit exceeded for user'
          }
        }
      }
    };

    const classified = GoogleApiErrorClassifier.classify(error);
    expect(classified.code).toBe(PhotosErrorCode.PHOTOS_RATE_LIMITED);
    expect(classified.statusCode).toBe(429);
  });

  it('should classify 503 error as PHOTOS_GOOGLE_API_ERROR', () => {
    const error = {
      response: {
        status: 503,
        data: {
          error: {
            message: 'Service Unavailable'
          }
        }
      }
    };

    const classified = GoogleApiErrorClassifier.classify(error);
    expect(classified.code).toBe(PhotosErrorCode.PHOTOS_GOOGLE_API_ERROR);
    expect(classified.statusCode).toBe(503);
  });
});
