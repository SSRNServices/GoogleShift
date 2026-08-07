import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { ManifestItem } from './ManifestStorage';

const MANIFEST_DIR = path.join(process.cwd(), 'data', 'manifests');

export class ManifestFileStorage {
  private static ensureDir() {
    if (!fs.existsSync(MANIFEST_DIR)) {
      fs.mkdirSync(MANIFEST_DIR, { recursive: true });
    }
  }

  public static getFilePath(manifestId: string): string {
    ManifestFileStorage.ensureDir();
    return path.join(MANIFEST_DIR, `${manifestId}.ndjson`);
  }

  public static async appendChunk(manifestId: string, chunk: ManifestItem[]): Promise<void> {
    if (chunk.length === 0) return;
    const filePath = ManifestFileStorage.getFilePath(manifestId);

    return new Promise((resolve, reject) => {
      const lines = chunk.map(item => JSON.stringify(item)).join('\n') + '\n';
      fs.appendFile(filePath, lines, 'utf8', (err) => {
        if (err) {
          console.error(`[ManifestFileStorage] Failed to append chunk to ${filePath}:`, err.message);
          return reject(err);
        }
        resolve();
      });
    });
  }

  public static exists(manifestId: string): boolean {
    const filePath = ManifestFileStorage.getFilePath(manifestId);
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  }

  public static async readAllItems(manifestId: string): Promise<ManifestItem[]> {
    const filePath = ManifestFileStorage.getFilePath(manifestId);
    if (!fs.existsSync(filePath)) return [];

    const items: ManifestItem[] = [];
    const fileStream = fs.createReadStream(filePath);
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
    const filePath = ManifestFileStorage.getFilePath(manifestId);
    if (!fs.existsSync(filePath)) return [];

    const items: ManifestItem[] = [];
    const fileStream = fs.createReadStream(filePath);
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
    const filePath = ManifestFileStorage.getFilePath(manifestId);
    if (!fs.existsSync(filePath)) return;

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
      await fs.promises.writeFile(filePath, lines, 'utf8');
    }
  }

  public static async deleteManifestFile(manifestId: string): Promise<void> {
    const filePath = ManifestFileStorage.getFilePath(manifestId);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath).catch(() => {});
    }
  }
}
