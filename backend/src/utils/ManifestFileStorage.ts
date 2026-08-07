import readline from 'readline';
import { ManifestItem } from './ManifestStorage';
import { defaultStorageProvider } from './storage/LocalStorageProvider';

export class ManifestFileStorage {
  public static getFilePath(manifestId: string): string {
    return defaultStorageProvider.getFilePath(`${manifestId}.ndjson`);
  }

  public static async appendChunk(manifestId: string, chunk: ManifestItem[]): Promise<void> {
    if (chunk.length === 0) return;
    const filename = `${manifestId}.ndjson`;
    const lines = chunk.map(item => JSON.stringify(item)).join('\n') + '\n';
    await defaultStorageProvider.append(filename, lines);
  }

  public static async exists(manifestId: string): Promise<boolean> {
    return defaultStorageProvider.exists(`${manifestId}.ndjson`);
  }

  public static async readAllItems(manifestId: string): Promise<ManifestItem[]> {
    const filename = `${manifestId}.ndjson`;
    const fileStream = defaultStorageProvider.readStream(filename);
    if (!fileStream) return [];

    const items: ManifestItem[] = [];
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          items.push(JSON.parse(line));
        } catch (_) {}
      }
    }
    return items;
  }

  public static async getPendingFoldersByDepth(manifestId: string): Promise<ManifestItem[]> {
    const all = await ManifestFileStorage.readAllItems(manifestId);
    return all
      .filter(item => item.isFolder && (item.status === 'PENDING' || item.status === 'QUEUED'))
      .sort((a, b) => (a.depth || 0) - (b.depth || 0));
  }

  public static async getPendingFiles(manifestId: string, limit: number): Promise<ManifestItem[]> {
    const filename = `${manifestId}.ndjson`;
    const fileStream = defaultStorageProvider.readStream(filename);
    if (!fileStream) return [];

    const items: ManifestItem[] = [];
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const item: ManifestItem = JSON.parse(line);
          if (!item.isFolder && (item.status === 'QUEUED' || item.status === 'PENDING')) {
            items.push(item);
            if (items.length >= limit) break;
          }
        } catch (_) {}
      }
    }
    return items;
  }

  public static async getStats(manifestId: string): Promise<{ totalFolders: number; totalFiles: number; totalBytes: number }> {
    const items = await ManifestFileStorage.readAllItems(manifestId);
    let totalFolders = 0;
    let totalFiles = 0;
    let totalBytes = 0;

    for (const item of items) {
      if (item.isFolder) {
        totalFolders++;
      } else {
        totalFiles++;
        totalBytes += Number(item.size || 0);
      }
    }

    return { totalFolders, totalFiles, totalBytes };
  }

  public static async updateItemStatus(manifestId: string, itemId: string, status: ManifestItem['status']): Promise<void> {
    const filename = `${manifestId}.ndjson`;
    const items = await ManifestFileStorage.readAllItems(manifestId);
    let updated = false;

    for (const item of items) {
      if (item.id === itemId) {
        item.status = status;
        updated = true;
        break;
      }
    }

    if (updated) {
      const lines = items.map(i => JSON.stringify(i)).join('\n') + '\n';
      await defaultStorageProvider.write(filename, lines);
    }
  }

  public static async deleteManifestFile(manifestId: string): Promise<void> {
    const filename = `${manifestId}.ndjson`;
    try {
      await defaultStorageProvider.delete(filename);
    } catch (err: any) {
      console.warn(`[ManifestFileStorage] Non-fatal deletion warning for ${filename}:`, err.message);
    }
  }
}
