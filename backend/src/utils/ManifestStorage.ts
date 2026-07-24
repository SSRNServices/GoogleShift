// @ts-nocheck
import { getDb } from './database';

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
  public static async createManifestTable() {
    const db = await getDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS migration_manifest (
        jobId TEXT,
        id TEXT,
        sourceId TEXT,
        sourceParentId TEXT,
        destParentId TEXT,
        createdDestId TEXT,
        name TEXT,
        mimeType TEXT,
        size INTEGER,
        originalId TEXT,
        originalMimeType TEXT,
        status TEXT,
        isFolder INTEGER,
        depth INTEGER,
        retryCount INTEGER DEFAULT 0,
        PRIMARY KEY (jobId, id)
      );
      CREATE INDEX IF NOT EXISTS idx_manifest_status ON migration_manifest(jobId, status);
      CREATE INDEX IF NOT EXISTS idx_manifest_parent ON migration_manifest(jobId, sourceParentId);
    `);
    
    // Schema migration for existing databases
    try {
      await db.exec(`ALTER TABLE migration_manifest ADD COLUMN createdDestId TEXT;`);
    } catch (e: any) {}
    try {
      await db.exec(`ALTER TABLE migration_manifest ADD COLUMN depth INTEGER DEFAULT 0;`);
    } catch (e: any) {}
    try {
      await db.exec(`ALTER TABLE migration_manifest ADD COLUMN retryCount INTEGER DEFAULT 0;`);
    } catch (e: any) {}
  }

  public static async insertItem(item: ManifestItem) {
    const db = await getDb();
    await db.run(`
      INSERT OR REPLACE INTO migration_manifest 
      (jobId, id, sourceId, sourceParentId, destParentId, createdDestId, name, mimeType, size, originalId, originalMimeType, status, isFolder, depth, retryCount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      item.jobId, item.id, item.sourceId, item.sourceParentId, item.destParentId, item.createdDestId,
      item.name, item.mimeType, item.size, item.originalId, item.originalMimeType,
      item.status, item.isFolder ? 1 : 0, item.depth || 0, item.retryCount || 0
    ]);
  }

  public static async updateDestParentId(jobId: string, sourceParentId: string, destParentId: string) {
    const db = await getDb();
    await db.run(`UPDATE migration_manifest SET destParentId = ? WHERE jobId = ? AND sourceParentId = ?`, [destParentId, jobId, sourceParentId]);
  }

  public static async updateItemStatus(jobId: string, id: string, status: ManifestItem['status']) {
    const db = await getDb();
    const row = await db.get(`SELECT status FROM migration_manifest WHERE jobId = ? AND id = ?`, [jobId, id]);
    if (!row) return;

    if (row.status === 'SUCCESS' || row.status === 'FAILED') {
       if (status !== 'SUCCESS' && status !== 'FAILED') {
          // Illegal transition from terminal state
          return;
       }
    }
    
    await db.run(`UPDATE migration_manifest SET status = ? WHERE jobId = ? AND id = ?`, [status, jobId, id]);
  }

  public static async incrementRetryCount(jobId: string, id: string): Promise<number> {
    const db = await getDb();
    await db.run(`UPDATE migration_manifest SET retryCount = retryCount + 1 WHERE jobId = ? AND id = ?`, [jobId, id]);
    const row = await db.get(`SELECT retryCount FROM migration_manifest WHERE jobId = ? AND id = ?`, [jobId, id]);
    return row ? row.retryCount : 0;
  }

  public static async getNextPendingItem(jobId: string): Promise<ManifestItem | null> {
    const db = await getDb();
    // Only fetch items where destParentId is known. Parents will unlock their children when processed.
    const row = await db.get(`
      SELECT * FROM migration_manifest 
      WHERE jobId = ? AND status = 'PENDING' AND destParentId IS NOT NULL
      ORDER BY isFolder DESC, id ASC 
      LIMIT 1
    `, [jobId]);
    if (!row) return null;
    return {
      ...row,
      isFolder: row.isFolder === 1
    } as ManifestItem;
  }

  public static async updateCreatedDestId(jobId: string, id: string, createdDestId: string) {
    const db = await getDb();
    await db.run(`UPDATE migration_manifest SET createdDestId = ? WHERE jobId = ? AND id = ?`, [createdDestId, jobId, id]);
  }

  public static async getChildren(jobId: string, sourceParentId: string): Promise<ManifestItem[]> {
    const db = await getDb();
    const rows = await db.all(`
      SELECT * FROM migration_manifest 
      WHERE jobId = ? AND sourceParentId = ?
    `, [jobId, sourceParentId]);
    return rows.map(row => ({
      ...row,
      isFolder: row.isFolder === 1
    })) as ManifestItem[];
  }

  public static async getPendingFoldersByDepth(jobId: string): Promise<ManifestItem[]> {
    const db = await getDb();
    const rows = await db.all(`
      SELECT * FROM migration_manifest 
      WHERE jobId = ? AND isFolder = 1 AND status = 'PENDING'
      ORDER BY depth ASC
    `, [jobId]);
    return rows.map(row => ({
      ...row,
      isFolder: row.isFolder === 1
    })) as ManifestItem[];
  }

  public static async getPendingFiles(jobId: string, limit: number): Promise<ManifestItem[]> {
    const db = await getDb();
    const rows = await db.all(`
      SELECT * FROM migration_manifest 
      WHERE jobId = ? AND isFolder = 0 AND status = 'QUEUED'
      ORDER BY depth ASC
      LIMIT ?
    `, [jobId, limit]);
    return rows.map(row => ({
      ...row,
      isFolder: row.isFolder === 1
    })) as ManifestItem[];
  }
}
