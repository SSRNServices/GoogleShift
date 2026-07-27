import { authService } from '../auth/auth.service';

export class StorageAnalyzer {
  public static async analyzeStorage(userId: string, totalIncomingBytes: number) {
    try {
      const destProfile = await authService.getProfile(userId, 'destination');
      
      if (destProfile?.state !== 'CONNECTED' || !destProfile.profile) {
        return {
          limit: 0,
          used: 0,
          remaining: 0,
          sufficient: true, // Fail open if we can't fetch it
          warnings: ['Failed to retrieve destination storage quota.']
        };
      }

      const limit = Number(destProfile.profile.storage.limit);
      const used = Number(destProfile.profile.storage.used);
      const remaining = limit - used;

      const sufficient = remaining >= totalIncomingBytes;
      const warnings: string[] = [];

      if (!sufficient) {
        warnings.push(`Insufficient destination storage. Required: ${this.formatBytes(totalIncomingBytes)}. Available: ${this.formatBytes(remaining)}.`);
      }

      // Calculate ETA based on a conservative 25 MB/s average
      // e.g. (totalBytes / (25 * 1024 * 1024)) = seconds
      const avgSpeedBytesPerSec = 25 * 1024 * 1024;
      const estimatedTimeSeconds = Math.ceil(totalIncomingBytes / avgSpeedBytesPerSec);

      return {
        limit,
        used,
        remaining,
        sufficient,
        warnings,
        estimatedTimeSeconds
      };
    } catch (e) {
      console.error('[StorageAnalyzer] Failed to analyze storage', e);
      return {
        limit: 0,
        used: 0,
        remaining: 0,
        sufficient: true,
        warnings: ['Storage validation failed due to an error.'],
        estimatedTimeSeconds: 0
      };
    }
  }

  private static formatBytes(bytes: number) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
