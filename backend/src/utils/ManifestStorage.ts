import fs from 'fs';
import path from 'path';
import { open, Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import { defaultStorageProvider } from './storage/LocalStorageProvider';
import { ManifestFileStorage } from './ManifestFileStorage';

export interface ManifestItem {
  id: string;
  jobId: string;
  sourceId: string;
  sourceParentId: string;
  destParentId: string | null;
  createdDestId: string | null;
  name: string;
  mimeType: string;
  size: number;
  originalId: string | null;
  originalMimeType: string | null;
  status: 'PENDING' | 'QUEUED' | 'DOWNLOADING' | 'UPLOADING' | 'VERIFYING' | 'SUCCESS' | 'FAILED';
  isFolder: boolean;
  depth: number;
  retryCount: number;
}

export class ManifestStorage {
  private static dbCache: Map<string, Promise<Database>> = new Map();

  private static getDbFilePath(manifestId: string): string {
    const safeFilename = path.basename(`${manifestId}.db`);
    return path.join(defaultStorageProvider.getStoragePath(), safeFilename);
  }

  private static async getDb(manifestId: string): Promise<Database> {
    if (this.dbCache.has(manifestId)) {
      return this.dbCache.get(manifestId)!;
    }

    const dbPromise = (async () => {
      await defaultStorageProvider.ensureDirectory();
      const filePath = this.getDbFilePath(manifestId);
      const db = await open({
        filename: filePath,
        driver: sqlite3.Database
      });

      await db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS manifest_items (
          id TEXT PRIMARY KEY,
          jobId TEXT NOT NULL,
          sourceId TEXT,
          sourceParentId TEXT,
          destParentId TEXT,
          createdDestId TEXT,
          name TEXT,
          mimeType TEXT,
          size INTEGER DEFAULT 0,
          originalId TEXT,
          originalMimeType TEXT,
          status TEXT DEFAULT 'PENDING',
          isFolder INTEGER DEFAULT 0,
          depth INTEGER DEFAULT 0,
          retryCount INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_sourceParentId ON manifest_items(sourceParentId);
        CREATE INDEX IF NOT EXISTS idx_isFolder_status_depth ON manifest_items(isFolder, status, depth);
        CREATE INDEX IF NOT EXISTS idx_status ON manifest_items(status);
      `);

      return db;
    })();

    this.dbCache.set(manifestId, dbPromise);
    return dbPromise;
  }

  public static async closeDb(manifestId: string): Promise<void> {
    if (this.dbCache.has(manifestId)) {
      try {
        const db = await this.dbCache.get(manifestId)!;
        await db.close();
      } catch (_) {}
      this.dbCache.delete(manifestId);
    }
  }

  public static async saveManifestChunk(chunk: ManifestItem[]): Promise<void> {
    if (chunk.length === 0) return;
    const manifestId = chunk[0].jobId;

    // 1. Append to NDJSON file stream for file-based stream consumers
    await ManifestFileStorage.appendChunk(manifestId, chunk).catch(() => {});

    // 2. Persist items to high-performance local SQLite database
    const db = await this.getDb(manifestId);
    await db.exec('BEGIN TRANSACTION;');

    try {
      const stmt = await db.prepare(`
        INSERT OR REPLACE INTO manifest_items (
          id, jobId, sourceId, sourceParentId, destParentId, createdDestId,
          name, mimeType, size, originalId, originalMimeType, status, isFolder, depth, retryCount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of chunk) {
        await stmt.run(
          item.id,
          item.jobId,
          item.sourceId || null,
          item.sourceParentId || null,
          item.destParentId || null,
          item.createdDestId || null,
          item.name || null,
          item.mimeType || null,
          Number(item.size || 0),
          item.originalId || null,
          item.originalMimeType || null,
          item.status || 'PENDING',
          item.isFolder ? 1 : 0,
          item.depth || 0,
          item.retryCount || 0
        );
      }

      await stmt.finalize();
      await db.exec('COMMIT;');
    } catch (err) {
      await db.exec('ROLLBACK;').catch(() => {});
      throw err;
    }
  }

  public static async saveManifest(items: ManifestItem[]): Promise<void> {
    const chunkSize = 1000;
    console.log(`[ManifestStorage] Starting batch insert for ${items.length} items...`);
    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      await ManifestStorage.saveManifestChunk(chunk);
    }
  }

  public static async updateDestParentId(manifestId: string, sourceParentId: string, destParentId: string): Promise<void> {
    const db = await this.getDb(manifestId);
    await db.run('UPDATE manifest_items SET destParentId = ? WHERE sourceParentId = ?', [destParentId, sourceParentId]);
  }

  public static async updateItemStatus(manifestId: string, id: string, status: ManifestItem['status']): Promise<void> {
    const db = await this.getDb(manifestId);
    const row = await db.get<{ status: string }>('SELECT status FROM manifest_items WHERE id = ?', [id]);
    if (row && (row.status === 'SUCCESS' || row.status === 'FAILED')) {
      if (status !== 'SUCCESS' && status !== 'FAILED') {
        return;
      }
    }

    await db.run('UPDATE manifest_items SET status = ? WHERE id = ?', [status, id]);
  }

  public static async incrementRetryCount(manifestId: string, id: string): Promise<number> {
    const db = await this.getDb(manifestId);
    await db.run('UPDATE manifest_items SET retryCount = retryCount + 1 WHERE id = ?', [id]);
    const row = await db.get<{ retryCount: number }>('SELECT retryCount FROM manifest_items WHERE id = ?', [id]);
    return row ? row.retryCount : 1;
  }

  public static async getNextPendingItem(manifestId: string): Promise<ManifestItem | null> {
    const db = await this.getDb(manifestId);
    const row = await db.get<any>(
      `SELECT * FROM manifest_items WHERE status = 'PENDING' AND destParentId IS NOT NULL ORDER BY isFolder DESC, id ASC LIMIT 1`
    );
    if (!row) return null;
    return {
      ...row,
      isFolder: Boolean(row.isFolder),
      size: Number(row.size)
    } as ManifestItem;
  }

  public static async getItem(manifestId: string, id: string): Promise<ManifestItem | null> {
    const db = await this.getDb(manifestId);
    const row = await db.get<any>('SELECT * FROM manifest_items WHERE id = ?', [id]);
    if (!row) return null;
    return {
      ...row,
      isFolder: Boolean(row.isFolder),
      size: Number(row.size)
    } as ManifestItem;
  }

  public static async updateCreatedDestId(manifestId: string, id: string, createdDestId: string): Promise<void> {
    const db = await this.getDb(manifestId);
    await db.run('UPDATE manifest_items SET createdDestId = ? WHERE id = ?', [createdDestId, id]);
  }

  public static async queueChildrenOf(manifestId: string, sourceParentId: string): Promise<{ count: number }> {
    const db = await this.getDb(manifestId);
    const result = await db.run(
      `UPDATE manifest_items SET status = 'QUEUED' WHERE sourceParentId = ? AND status = 'PENDING'`,
      [sourceParentId]
    );
    return { count: result.changes || 0 };
  }

  public static async getFailedItems(manifestId: string): Promise<ManifestItem[]> {
    const db = await this.getDb(manifestId);
    const rows = await db.all<any[]>(
      `SELECT * FROM manifest_items WHERE status = 'FAILED' AND isFolder = 0`
    );
    return rows.map(r => ({
      ...r,
      isFolder: false,
      size: Number(r.size)
    })) as ManifestItem[];
  }

  public static async getFolderCache(manifestId: string): Promise<Map<string, string>> {
    const db = await this.getDb(manifestId);
    const rows = await db.all<Array<{ id: string; createdDestId: string | null }>>(
      `SELECT id, createdDestId FROM manifest_items WHERE isFolder = 1 AND createdDestId IS NOT NULL`
    );
    const cache = new Map<string, string>();
    for (const r of rows) {
      if (r.createdDestId) cache.set(r.id, r.createdDestId);
    }
    return cache;
  }

  public static async getChildren(manifestId: string, sourceParentId: string): Promise<ManifestItem[]> {
    const db = await this.getDb(manifestId);
    const rows = await db.all<any[]>('SELECT * FROM manifest_items WHERE sourceParentId = ?', [sourceParentId]);
    return rows.map(row => ({
      ...row,
      isFolder: Boolean(row.isFolder),
      size: Number(row.size)
    })) as ManifestItem[];
  }

  public static async getPendingFoldersByDepth(manifestId: string): Promise<ManifestItem[]> {
    const db = await this.getDb(manifestId);
    const rows = await db.all<any[]>(
      `SELECT * FROM manifest_items WHERE isFolder = 1 AND status IN ('PENDING', 'QUEUED') ORDER BY depth ASC`
    );
    return rows.map(row => ({
      ...row,
      isFolder: Boolean(row.isFolder),
      size: Number(row.size)
    })) as ManifestItem[];
  }

  public static async getPendingFiles(manifestId: string, limit: number): Promise<ManifestItem[]> {
    const db = await this.getDb(manifestId);
    const rows = await db.all<any[]>(
      `SELECT * FROM manifest_items WHERE isFolder = 0 AND status IN ('PENDING', 'QUEUED') ORDER BY depth ASC LIMIT ?`,
      [limit]
    );
    return rows.map(row => ({
      ...row,
      isFolder: Boolean(row.isFolder),
      size: Number(row.size)
    })) as ManifestItem[];
  }

  public static async countItems(
    manifestId: string,
    filter?: { isFolder?: boolean; status?: string | string[]; statusIn?: string[] }
  ): Promise<number> {
    const db = await this.getDb(manifestId);
    let query = 'SELECT COUNT(*) as count FROM manifest_items WHERE 1=1';
    const params: any[] = [];

    if (filter?.isFolder !== undefined) {
      query += ' AND isFolder = ?';
      params.push(filter.isFolder ? 1 : 0);
    }

    if (filter?.status) {
      if (Array.isArray(filter.status)) {
        query += ` AND status IN (${filter.status.map(() => '?').join(',')})`;
        params.push(...filter.status);
      } else {
        query += ' AND status = ?';
        params.push(filter.status);
      }
    }

    if (filter?.statusIn) {
      query += ` AND status IN (${filter.statusIn.map(() => '?').join(',')})`;
      params.push(...filter.statusIn);
    }

    const row = await db.get<{ count: number }>(query, params);
    return row ? row.count : 0;
  }

  public static async updateManyStatus(
    manifestId: string,
    filter: { isFolder?: boolean; statusIn?: string[] },
    newStatus: string,
    resetCreatedDestId: boolean = false
  ): Promise<{ count: number }> {
    const db = await this.getDb(manifestId);
    let query = 'UPDATE manifest_items SET status = ?';
    const params: any[] = [newStatus];

    if (resetCreatedDestId) {
      query += ', createdDestId = NULL';
    }

    query += ' WHERE 1=1';

    if (filter.isFolder !== undefined) {
      query += ' AND isFolder = ?';
      params.push(filter.isFolder ? 1 : 0);
    }

    if (filter.statusIn && filter.statusIn.length > 0) {
      query += ` AND status IN (${filter.statusIn.map(() => '?').join(',')})`;
      params.push(...filter.statusIn);
    }

    const result = await db.run(query, params);
    return { count: result.changes || 0 };
  }

  public static async resetAllStatus(manifestId: string, newStatus: string = 'PENDING'): Promise<{ count: number }> {
    const db = await this.getDb(manifestId);
    const result = await db.run('UPDATE manifest_items SET status = ?, createdDestId = NULL', [newStatus]);
    return { count: result.changes || 0 };
  }

  public static async getSummaryStats(manifestId: string): Promise<{
    totalFolders: number;
    totalFiles: number;
    totalBytes: number;
    completedFiles: number;
    failedFiles: number;
    transferredBytes: number;
  }> {
    const db = await this.getDb(manifestId);
    const rows = await db.all<any[]>(`
      SELECT 
        isFolder,
        status,
        COUNT(*) as cnt,
        SUM(size) as totalSz
      FROM manifest_items
      GROUP BY isFolder, status
    `);

    let totalFolders = 0;
    let totalFiles = 0;
    let totalBytes = 0;
    let completedFiles = 0;
    let failedFiles = 0;
    let transferredBytes = 0;

    for (const r of rows) {
      const cnt = Number(r.cnt || 0);
      const sz = Number(r.totalSz || 0);
      const isFolder = Boolean(r.isFolder);

      if (isFolder) {
        totalFolders += cnt;
      } else {
        totalFiles += cnt;
        totalBytes += sz;
        if (r.status === 'SUCCESS') {
          completedFiles += cnt;
          transferredBytes += sz;
        } else if (r.status === 'FAILED') {
          failedFiles += cnt;
        }
      }
    }

    return {
      totalFolders,
      totalFiles,
      totalBytes,
      completedFiles,
      failedFiles,
      transferredBytes
    };
  }

  public static async hasManifest(manifestId: string): Promise<boolean> {
    const filePath = this.getDbFilePath(manifestId);
    return fs.existsSync(filePath);
  }

  public static async deleteManifest(manifestId: string): Promise<void> {
    await this.closeDb(manifestId);
    const dbPath = this.getDbFilePath(manifestId);
    try {
      if (fs.existsSync(dbPath)) {
        await fs.promises.unlink(dbPath);
      }
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      if (fs.existsSync(walPath)) await fs.promises.unlink(walPath).catch(() => {});
      if (fs.existsSync(shmPath)) await fs.promises.unlink(shmPath).catch(() => {});
    } catch (err: any) {
      console.warn(`[ManifestStorage] Non-fatal DB file deletion warning for ${manifestId}:`, err.message);
    }

    await ManifestFileStorage.deleteManifestFile(manifestId).catch(() => {});
  }
}
