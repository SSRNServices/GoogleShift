import path from 'path';
import { open, Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import { defaultStorageProvider } from './storage/LocalStorageProvider';

export interface PhotosBatchInfo {
  id: string;
  manifestId: string;
  pickerSessionId: string;
  batchNumber: number;
  selectedCount: number;
  newCount: number;
  duplicateCount: number;
  photosCount: number;
  videosCount: number;
  totalBytes: number;
  status: string;
  createdAt: number;
}

export interface PhotosManifestItem {
  id: string;
  jobId: string;
  sourceMediaId: string;
  sourceFilename: string;
  mimeType: string;
  size: number;
  creationTime: string | null;
  baseUrl?: string | null;
  mediaType: 'PHOTO' | 'VIDEO';
  albumIds: string[]; // JSON array of source album IDs
  destAlbumIds: string[]; // JSON array of dest album IDs
  destMediaId: string | null;
  checksum: string | null;
  status: 'PENDING' | 'QUEUED' | 'DOWNLOADING' | 'UPLOADING' | 'VERIFYING' | 'SUCCESS' | 'VERIFIED' | 'FAILED' | 'SKIPPED';
  retryCount: number;
  error: string | null;
  lastAttemptAt: number | null;
  verifiedAt: number | null;
  createdAt: number;
}

export interface PhotosAlbumItem {
  id: string;
  jobId: string;
  sourceAlbumId: string;
  title: string;
  mediaItemsCount: number;
  destAlbumId: string | null;
  status: 'PENDING' | 'CREATING' | 'CREATED' | 'FAILED';
  error: string | null;
}

export class PhotosManifestStorage {
  private static dbCache: Map<string, Promise<Database>> = new Map();
  private static writeQueues: Map<string, Promise<any>> = new Map();

  private static async runWithLock<T>(manifestId: string, fn: () => Promise<T>): Promise<T> {
    const current = this.writeQueues.get(manifestId) || Promise.resolve();
    const next = current
      .catch(() => {})
      .then(fn);
    this.writeQueues.set(manifestId, next);
    return next;
  }

  private static getDbFilePath(manifestId: string): string {
    const safeFilename = path.basename(`photos_${manifestId}.db`);
    return path.join(defaultStorageProvider.getStoragePath(), safeFilename);
  }

  public static async getDb(manifestId: string): Promise<Database> {
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

        CREATE TABLE IF NOT EXISTS photos_manifest_items (
          id TEXT PRIMARY KEY,
          jobId TEXT NOT NULL,
          sourceMediaId TEXT NOT NULL,
          sourceFilename TEXT,
          mimeType TEXT,
          size INTEGER DEFAULT 0,
          creationTime TEXT,
          baseUrl TEXT,
          mediaType TEXT DEFAULT 'PHOTO',
          albumIds TEXT DEFAULT '[]',
          destAlbumIds TEXT DEFAULT '[]',
          destMediaId TEXT,
          checksum TEXT,
          status TEXT DEFAULT 'PENDING',
          retryCount INTEGER DEFAULT 0,
          error TEXT,
          lastAttemptAt INTEGER,
          verifiedAt INTEGER,
          createdAt INTEGER
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_job_sourceId ON photos_manifest_items(jobId, sourceMediaId);
        CREATE INDEX IF NOT EXISTS idx_photos_status ON photos_manifest_items(status);
        CREATE INDEX IF NOT EXISTS idx_photos_mediaType ON photos_manifest_items(mediaType);

        CREATE TABLE IF NOT EXISTS photos_albums (
          id TEXT PRIMARY KEY,
          jobId TEXT NOT NULL,
          sourceAlbumId TEXT NOT NULL,
          title TEXT NOT NULL,
          mediaItemsCount INTEGER DEFAULT 0,
          destAlbumId TEXT,
          status TEXT DEFAULT 'PENDING',
          error TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_albums_job_source ON photos_albums(jobId, sourceAlbumId);

        CREATE TABLE IF NOT EXISTS photos_batches (
          id TEXT PRIMARY KEY,
          manifestId TEXT NOT NULL,
          pickerSessionId TEXT NOT NULL,
          batchNumber INTEGER NOT NULL,
          selectedCount INTEGER DEFAULT 0,
          newCount INTEGER DEFAULT 0,
          duplicateCount INTEGER DEFAULT 0,
          photosCount INTEGER DEFAULT 0,
          videosCount INTEGER DEFAULT 0,
          totalBytes INTEGER DEFAULT 0,
          status TEXT DEFAULT 'COMPLETED',
          createdAt INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_photos_batches_manifest ON photos_batches(manifestId);
      `);

      return db;
    })();

    this.dbCache.set(manifestId, dbPromise);
    return dbPromise;
  }

  public static async closeDb(manifestId: string): Promise<void> {
    this.writeQueues.delete(manifestId);
    if (this.dbCache.has(manifestId)) {
      try {
        const db = await this.dbCache.get(manifestId)!;
        await db.close();
      } catch (_) {}
      this.dbCache.delete(manifestId);
    }
  }

  public static async recordBatch(manifestId: string, batch: PhotosBatchInfo): Promise<void> {
    const db = await this.getDb(manifestId);
    await db.run(
      `INSERT INTO photos_batches (
        id, manifestId, pickerSessionId, batchNumber, selectedCount, newCount,
        duplicateCount, photosCount, videosCount, totalBytes, status, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        selectedCount=excluded.selectedCount,
        newCount=excluded.newCount,
        duplicateCount=excluded.duplicateCount,
        photosCount=excluded.photosCount,
        videosCount=excluded.videosCount,
        totalBytes=excluded.totalBytes,
        status=excluded.status;`,
      [
        batch.id,
        batch.manifestId,
        batch.pickerSessionId,
        batch.batchNumber,
        batch.selectedCount,
        batch.newCount,
        batch.duplicateCount,
        batch.photosCount,
        batch.videosCount,
        batch.totalBytes,
        batch.status || 'COMPLETED',
        batch.createdAt || Date.now()
      ]
    );
  }

  public static async getBatches(manifestId: string): Promise<PhotosBatchInfo[]> {
    const db = await this.getDb(manifestId);
    const rows = await db.all<any[]>('SELECT * FROM photos_batches ORDER BY batchNumber ASC');
    return rows.map(r => ({
      id: r.id,
      manifestId: r.manifestId,
      pickerSessionId: r.pickerSessionId,
      batchNumber: Number(r.batchNumber || 1),
      selectedCount: Number(r.selectedCount || 0),
      newCount: Number(r.newCount || 0),
      duplicateCount: Number(r.duplicateCount || 0),
      photosCount: Number(r.photosCount || 0),
      videosCount: Number(r.videosCount || 0),
      totalBytes: Number(r.totalBytes || 0),
      status: r.status || 'COMPLETED',
      createdAt: Number(r.createdAt || Date.now())
    }));
  }

  public static async saveMediaItemsChunk(
    manifestId: string,
    items: PhotosManifestItem[]
  ): Promise<{ newCount: number; duplicateCount: number }> {
    if (items.length === 0) return { newCount: 0, duplicateCount: 0 };

    return this.runWithLock(manifestId, async () => {
      const db = await this.getDb(manifestId);

      // Check existing sourceMediaIds to compute deduplication count
      const existingRows = await db.all<Array<{ sourceMediaId: string }>>(
        'SELECT sourceMediaId FROM photos_manifest_items WHERE jobId = ?',
        [manifestId]
      );
      const existingSet = new Set(existingRows.map(r => r.sourceMediaId));

      let newCount = 0;
      let duplicateCount = 0;

      for (const item of items) {
        if (existingSet.has(item.sourceMediaId)) {
          duplicateCount++;
        } else {
          newCount++;
          existingSet.add(item.sourceMediaId);
        }
      }

      await db.exec('BEGIN TRANSACTION;');
      try {
        const stmt = await db.prepare(`
          INSERT INTO photos_manifest_items (
            id, jobId, sourceMediaId, sourceFilename, mimeType, size, creationTime, baseUrl,
            mediaType, albumIds, destAlbumIds, destMediaId, checksum, status,
            retryCount, error, lastAttemptAt, verifiedAt, createdAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(jobId, sourceMediaId) DO UPDATE SET
            sourceFilename=excluded.sourceFilename,
            mimeType=excluded.mimeType,
            size=excluded.size,
            creationTime=excluded.creationTime,
            baseUrl=COALESCE(excluded.baseUrl, photos_manifest_items.baseUrl),
            albumIds=excluded.albumIds;
        `);

        for (const item of items) {
          await stmt.run(
            item.id,
            item.jobId,
            item.sourceMediaId,
            item.sourceFilename || null,
            item.mimeType || 'image/jpeg',
            Number(item.size || 0),
            item.creationTime || null,
            item.baseUrl || null,
            item.mediaType || 'PHOTO',
            JSON.stringify(item.albumIds || []),
            JSON.stringify(item.destAlbumIds || []),
            item.destMediaId || null,
            item.checksum || null,
            item.status || 'PENDING',
            item.retryCount || 0,
            item.error || null,
            item.lastAttemptAt || null,
            item.verifiedAt || null,
            item.createdAt || Date.now()
          );
        }

        await stmt.finalize();
        await db.exec('COMMIT;');
      } catch (err) {
        await db.exec('ROLLBACK;').catch(() => {});
        throw err;
      }

      return { newCount, duplicateCount };
    });
  }

  public static async saveAlbums(manifestId: string, albums: PhotosAlbumItem[]): Promise<void> {
    if (albums.length === 0) return;

    return this.runWithLock(manifestId, async () => {
      const db = await this.getDb(manifestId);
      await db.exec('BEGIN TRANSACTION;');
      try {
        const stmt = await db.prepare(`
          INSERT INTO photos_albums (
            id, jobId, sourceAlbumId, title, mediaItemsCount, destAlbumId, status, error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(jobId, sourceAlbumId) DO UPDATE SET
            title=excluded.title,
            mediaItemsCount=excluded.mediaItemsCount;
        `);

        for (const alb of albums) {
          await stmt.run(
            alb.id,
            alb.jobId,
            alb.sourceAlbumId,
            alb.title,
            alb.mediaItemsCount || 0,
            alb.destAlbumId || null,
            alb.status || 'PENDING',
            alb.error || null
          );
        }

        await stmt.finalize();
        await db.exec('COMMIT;');
      } catch (err) {
        await db.exec('ROLLBACK;').catch(() => {});
        throw err;
      }
    });
  }

  public static async updateItemStatus(
    manifestId: string,
    id: string,
    status: PhotosManifestItem['status'],
    destMediaId?: string | null,
    error?: string | null,
    checksum?: string | null
  ): Promise<void> {
    const db = await this.getDb(manifestId);
    const now = Date.now();

    let query = 'UPDATE photos_manifest_items SET status = ?, lastAttemptAt = ?';
    const params: any[] = [status, now];

    if (destMediaId !== undefined) {
      query += ', destMediaId = ?';
      params.push(destMediaId);
    }
    if (error !== undefined) {
      query += ', error = ?';
      params.push(error);
    }
    if (checksum !== undefined) {
      query += ', checksum = ?';
      params.push(checksum);
    }
    if (status === 'SUCCESS' || status === 'VERIFIED') {
      query += ', verifiedAt = ?';
      params.push(now);
    }

    query += ' WHERE id = ?';
    params.push(id);

    await db.run(query, params);
  }

  public static async incrementRetryCount(manifestId: string, id: string): Promise<number> {
    const db = await this.getDb(manifestId);
    await db.run('UPDATE photos_manifest_items SET retryCount = retryCount + 1, lastAttemptAt = ? WHERE id = ?', [Date.now(), id]);
    const row = await db.get<{ retryCount: number }>('SELECT retryCount FROM photos_manifest_items WHERE id = ?', [id]);
    return row ? row.retryCount : 1;
  }

  public static async updateAlbumStatus(
    manifestId: string,
    sourceAlbumId: string,
    status: PhotosAlbumItem['status'],
    destAlbumId?: string | null,
    error?: string | null
  ): Promise<void> {
    const db = await this.getDb(manifestId);
    let query = 'UPDATE photos_albums SET status = ?';
    const params: any[] = [status];

    if (destAlbumId !== undefined) {
      query += ', destAlbumId = ?';
      params.push(destAlbumId);
    }
    if (error !== undefined) {
      query += ', error = ?';
      params.push(error);
    }

    query += ' WHERE sourceAlbumId = ?';
    params.push(sourceAlbumId);

    await db.run(query, params);
  }

  public static async getAlbums(manifestId: string): Promise<PhotosAlbumItem[]> {
    const db = await this.getDb(manifestId);
    const rows = await db.all<any[]>('SELECT * FROM photos_albums ORDER BY title ASC');
    return rows.map(r => ({
      ...r,
      mediaItemsCount: Number(r.mediaItemsCount || 0)
    }));
  }

  public static async getPendingFiles(manifestId: string, limit: number = 50): Promise<PhotosManifestItem[]> {
    const db = await this.getDb(manifestId);
    const rows = await db.all<any[]>(
      `SELECT * FROM photos_manifest_items WHERE status IN ('PENDING', 'QUEUED') ORDER BY createdAt ASC LIMIT ?`,
      [limit]
    );
    return rows.map(r => ({
      ...r,
      size: Number(r.size || 0),
      albumIds: JSON.parse(r.albumIds || '[]'),
      destAlbumIds: JSON.parse(r.destAlbumIds || '[]')
    }));
  }

  public static async getFailedItems(manifestId: string): Promise<PhotosManifestItem[]> {
    const db = await this.getDb(manifestId);
    const rows = await db.all<any[]>(
      `SELECT * FROM photos_manifest_items WHERE status = 'FAILED'`
    );
    return rows.map(r => ({
      ...r,
      size: Number(r.size || 0),
      albumIds: JSON.parse(r.albumIds || '[]'),
      destAlbumIds: JSON.parse(r.destAlbumIds || '[]')
    }));
  }

  public static async resetFailedItems(manifestId: string, itemIds?: string[]): Promise<number> {
    const db = await this.getDb(manifestId);
    if (itemIds && itemIds.length > 0) {
      const placeholders = itemIds.map(() => '?').join(',');
      const res = await db.run(
        `UPDATE photos_manifest_items SET status = 'QUEUED', retryCount = 0, error = NULL WHERE id IN (${placeholders})`,
        itemIds
      );
      return res.changes || 0;
    } else {
      const res = await db.run(
        `UPDATE photos_manifest_items SET status = 'QUEUED', retryCount = 0, error = NULL WHERE status = 'FAILED'`
      );
      return res.changes || 0;
    }
  }

  public static async countItems(
    manifestId: string,
    filter?: { status?: string | string[]; mediaType?: 'PHOTO' | 'VIDEO' }
  ): Promise<number> {
    const db = await this.getDb(manifestId);
    let query = 'SELECT COUNT(*) as count FROM photos_manifest_items WHERE 1=1';
    const params: any[] = [];

    if (filter?.mediaType) {
      query += ' AND mediaType = ?';
      params.push(filter.mediaType);
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

    const row = await db.get<{ count: number }>(query, params);
    return row ? row.count : 0;
  }

  public static async resetIncompleteStatus(manifestId: string): Promise<number> {
    const db = await this.getDb(manifestId);
    const res = await db.run(
      `UPDATE photos_manifest_items SET status = 'QUEUED' WHERE status IN ('DOWNLOADING', 'UPLOADING', 'VERIFYING')`
    );
    return res.changes || 0;
  }

  public static async getSummaryStats(manifestId: string): Promise<{
    manifestId: string;
    totalItems: number;
    photosCount: number;
    videosCount: number;
    albumsCount: number;
    completedItems: number;
    failedItems: number;
    pendingItems: number;
    totalBytes: number;
    transferredBytes: number;
    batches: PhotosBatchInfo[];
  }> {
    const db = await this.getDb(manifestId);
    const batches = await this.getBatches(manifestId);

    const itemRows = await db.all<any[]>(`
      SELECT 
        mediaType,
        status,
        COUNT(*) as cnt,
        SUM(size) as totalSz
      FROM photos_manifest_items
      GROUP BY mediaType, status
    `);

    const albumRow = await db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM photos_albums');
    const albumsCount = Number(albumRow?.cnt || 0);

    let totalItems = 0;
    let photosCount = 0;
    let videosCount = 0;
    let completedItems = 0;
    let failedItems = 0;
    let pendingItems = 0;
    let totalBytes = 0;
    let transferredBytes = 0;

    for (const r of itemRows) {
      const cnt = Number(r.cnt || 0);
      const sz = Number(r.totalSz || 0);
      const mediaType = r.mediaType;

      totalItems += cnt;
      totalBytes += sz;

      if (mediaType === 'VIDEO') {
        videosCount += cnt;
      } else {
        photosCount += cnt;
      }

      if (r.status === 'SUCCESS' || r.status === 'VERIFIED' || r.status === 'SKIPPED') {
        completedItems += cnt;
        transferredBytes += sz;
      } else if (r.status === 'FAILED') {
        failedItems += cnt;
      } else {
        pendingItems += cnt;
      }
    }

    return {
      manifestId,
      totalItems,
      photosCount,
      videosCount,
      albumsCount,
      completedItems,
      failedItems,
      pendingItems,
      totalBytes,
      transferredBytes,
      batches
    };
  }
}

