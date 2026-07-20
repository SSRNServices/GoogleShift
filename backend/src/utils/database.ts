import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (db) return db;

  const dbPath = path.resolve(__dirname, '../../migration.db');
  
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS migration_jobs (
      jobId TEXT PRIMARY KEY,
      status TEXT,
      networkStatus TEXT DEFAULT 'online',
      retryCount INTEGER DEFAULT 0,
      sourceSelection TEXT,
      destinationFolder TEXT,
      options TEXT,
      totalFolders INTEGER DEFAULT 0,
      totalFiles INTEGER DEFAULT 0,
      totalBytes INTEGER DEFAULT 0,
      completedFolders INTEGER DEFAULT 0,
      completedFiles INTEGER DEFAULT 0,
      failedFiles INTEGER DEFAULT 0,
      transferredBytes INTEGER DEFAULT 0,
      currentFile TEXT DEFAULT '',
      currentFolder TEXT DEFAULT '',
      lastSuccessfulFile TEXT DEFAULT '',
      startedAt INTEGER,
      updatedAt INTEGER,
      finishedAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS migration_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId TEXT,
      timestamp INTEGER,
      message TEXT
    );

    CREATE TABLE IF NOT EXISTS migration_checkpoints (
      jobId TEXT,
      type TEXT, 
      folderId TEXT,
      fileId TEXT,
      status TEXT,
      PRIMARY KEY (jobId, folderId, fileId)
    );
  `);

  const { ManifestStorage } = await import('./ManifestStorage');
  await ManifestStorage.createManifestTable();

  return db;
}

export async function createJob(jobId: string, payload: any) {
  const db = await getDb();
  
  const stats = await db.get(`
    SELECT 
      SUM(CASE WHEN isFolder = 1 THEN 1 ELSE 0 END) as totalFolders,
      SUM(CASE WHEN isFolder = 0 THEN 1 ELSE 0 END) as totalFiles,
      SUM(size) as totalBytes
    FROM migration_manifest 
    WHERE jobId = ?
  `, [jobId]);

  const totalFolders = stats?.totalFolders || 0;
  const totalFiles = stats?.totalFiles || 0;
  const totalBytes = stats?.totalBytes || 0;

  await db.run(
    `INSERT INTO migration_jobs (jobId, status, sourceSelection, destinationFolder, options, totalFolders, totalFiles, totalBytes, startedAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId, 
      'queued', 
      JSON.stringify(payload.sourceSelection), 
      JSON.stringify(payload.destinationFolder),
      JSON.stringify(payload.options),
      totalFolders,
      totalFiles,
      totalBytes,
      Date.now(),
      Date.now()
    ]
  );
}

export async function updateJobStatus(jobId: string, status: string) {
  const db = await getDb();
  await db.run(`UPDATE migration_jobs SET status = ?, updatedAt = ? WHERE jobId = ?`, [status, Date.now(), jobId]);
}

export async function logJobEvent(jobId: string, message: string) {
  const db = await getDb();
  await db.run(`INSERT INTO migration_logs (jobId, timestamp, message) VALUES (?, ?, ?)`, [jobId, Date.now(), message]);
  
  // also emit if needed, but we will poll/stream from DB
}

export async function updateJobProgress(jobId: string, updates: Partial<{
  totalFolders: number,
  totalFiles: number,
  totalBytes: number,
  completedFolders: number,
  completedFiles: number,
  failedFiles: number,
  transferredBytes: number,
  currentFile: string,
  currentFolder: string,
  lastSuccessfulFile: string,
  networkStatus: string,
  retryCount: number,
  status: string
}>) {
  const db = await getDb();
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  
  const setString = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => (updates as any)[k]);
  
  await db.run(`UPDATE migration_jobs SET ${setString}, updatedAt = ? WHERE jobId = ?`, [...values, Date.now(), jobId]);
}

export async function saveCheckpoint(jobId: string, type: 'folder' | 'file', folderId: string, fileId: string, status: string) {
  const db = await getDb();
  await db.run(`INSERT OR REPLACE INTO migration_checkpoints (jobId, type, folderId, fileId, status) VALUES (?, ?, ?, ?, ?)`, [jobId, type, folderId, fileId, status]);
}

export async function getCheckpoint(jobId: string, type: 'folder' | 'file', folderId: string, fileId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.get(`SELECT status FROM migration_checkpoints WHERE jobId = ? AND type = ? AND folderId = ? AND fileId = ?`, [jobId, type, folderId, fileId]);
  return row ? row.status : null;
}
