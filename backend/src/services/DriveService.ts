// @ts-nocheck
import { google, drive_v3 } from 'googleapis';
import { googleClientManager } from '../auth/google.client';
import { AccountType } from '../auth/token.store';
import { pLimit } from '../utils/pLimit';

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  createdTime?: string;
  owner?: string;
  icon?: string;
  thumbnail?: string;
  parentId?: string;
  childrenCount?: number;
}

export class DriveService {
  private async getDriveClient(userId: string, type: AccountType): Promise<drive_v3.Drive> {
    const auth = await googleClientManager.getAuthenticatedClient(userId, type);
    if (!auth) {
      throw new Error(`Account ${type} is not authenticated`);
    }
    return google.drive({ version: 'v3', auth });
  }

  private mapFile(file: drive_v3.Schema$File): DriveItem {
    return {
      id: file.id || '',
      name: file.name || '',
      mimeType: file.mimeType || '',
      size: file.size ? parseInt(file.size, 10) : undefined,
      modifiedTime: file.modifiedTime || undefined,
      createdTime: file.createdTime || undefined,
      owner: file.owners?.[0]?.displayName || undefined,
      icon: file.iconLink || undefined,
      thumbnail: file.thumbnailLink || undefined,
      parentId: file.parents?.[0] || undefined,
      shortcutDetails: file.shortcutDetails ? {
        targetId: file.shortcutDetails.targetId || undefined,
        targetMimeType: file.shortcutDetails.targetMimeType || undefined
      } : undefined
    };
  }

  public async getFolderContents(userId: string, type: AccountType, folderId: string, pageToken?: string) {
    const drive = await this.getDriveClient(userId, type);
    
    // Resolve 'root' to the actual root ID
    const queryId = folderId === 'root' ? 'root' : folderId;

    const res = await drive.files.list({
      q: `'${queryId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents, shortcutDetails)',
      orderBy: 'folder, name',
      pageSize: 50,
      pageToken: pageToken,
    });

    return {
      files: (res.data.files || []).map(this.mapFile),
      nextPageToken: res.data.nextPageToken,
    };
  }

  public async search(userId: string, type: AccountType, query: string, pageToken?: string) {
    const drive = await this.getDriveClient(userId, type);
    
    const res = await drive.files.list({
      q: `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents, shortcutDetails)',
      orderBy: 'folder, name',
      pageSize: 50,
      pageToken: pageToken,
    });

    return {
      files: (res.data.files || []).map(this.mapFile),
      nextPageToken: res.data.nextPageToken,
    };
  }

  public async getSharedWithMe(userId: string, type: AccountType, pageToken?: string) {
    const drive = await this.getDriveClient(userId, type);
    
    const res = await drive.files.list({
      q: `sharedWithMe = true and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents, shortcutDetails)',
      orderBy: 'folder, name',
      pageSize: 50,
      pageToken: pageToken,
    });

    return {
      files: (res.data.files || []).map(this.mapFile),
      nextPageToken: res.data.nextPageToken,
    };
  }

  public async getRecent(userId: string, type: AccountType, pageToken?: string) {
    const drive = await this.getDriveClient(userId, type);
    
    const res = await drive.files.list({
      q: `trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents, shortcutDetails)',
      orderBy: 'modifiedTime desc',
      pageSize: 50,
      pageToken: pageToken,
    });

    return {
      files: (res.data.files || []).map(this.mapFile),
      nextPageToken: res.data.nextPageToken,
    };
  }

  public async getStarred(userId: string, type: AccountType, pageToken?: string) {
    const drive = await this.getDriveClient(userId, type);
    
    const res = await drive.files.list({
      q: `starred = true and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents, shortcutDetails)',
      orderBy: 'folder, name',
      pageSize: 50,
      pageToken: pageToken,
    });

    return {
      files: (res.data.files || []).map(this.mapFile),
      nextPageToken: res.data.nextPageToken,
    };
  }

  public async createFolder(userId: string, type: AccountType, name: string, parentId?: string) {
    const drive = await this.getDriveClient(userId, type);
    
    const fileMetadata: any = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
    };
    
    if (parentId && parentId !== 'root') {
      fileMetadata.parents = [parentId];
    }

    const res = await drive.files.create({
      requestBody: fileMetadata,
      fields: 'id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents, shortcutDetails',
    });

    return this.mapFile(res.data);
  }
  
  public async getFolderInfo(userId: string, type: AccountType, folderId: string) {
    const drive = await this.getDriveClient(userId, type);
    const res = await drive.files.get({
        fileId: folderId === 'root' ? 'root' : folderId,
        fields: 'id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents, shortcutDetails'
    });
    
    // If it's root, the name might just be 'My Drive' or something similar.
    return this.mapFile(res.data);
  }

  public async getRoot(userId: string, type: AccountType, pageToken?: string) {
    const drive = await this.getDriveClient(userId, type);
    
    // 1. Fetch real root metadata
    const rootMetaRes = await drive.files.get({
      fileId: 'root',
      fields: 'id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents, shortcutDetails'
    });
    
    // 2. Fetch root children
    const contents = await this.getFolderContents(userId, type, 'root', pageToken);

    return {
      folder: this.mapFile(rootMetaRes.data),
      files: contents.files,
      nextPageToken: contents.nextPageToken
    };
  }

  public async getSelectionSummary(
    userId: string,
    type: AccountType, 
    items: { id: string, isFolder: boolean }[], 
    onProgress: (folders: number, files: number, bytes: number, currentAction: string, summary?: any) => Promise<void> | void,
    manifestId: string
  ) {
    const drive = await this.getDriveClient(userId, type);
    
    let totalFolders = 0;
    let totalFiles = 0;
    let totalBytes = 0;
    let googleDocs = 0;
    let googleSheets = 0;
    let googleSlides = 0;
    let unsupported = 0;
    let duplicates = 0;
    let largestFile = 0;
    const fileHashes = new Set<string>();

    const startTime = Date.now();
    console.log(`[Backend] Recursive scan started for ${type} account, ${items.length} items. Manifest: ${manifestId}`);

    const { DriveTraversalEngine } = await import('./DriveTraversalEngine');
    const { ManifestStorage } = await import('../utils/ManifestStorage');
    const { RetryHelper } = await import('../utils/retry');
    
    const apiWrapper = async <T>(name: string, op: () => Promise<T>): Promise<T> => {
       return RetryHelper.withRetry(name, op, (msg) => console.log(msg));
    };

    const manifestItems: any[] = []; // Collect items in memory

    const engine = new DriveTraversalEngine<{ parentId: string, depth: number }>(drive, {
      onFolderEnter: async (folder, context) => {
        totalFolders++;
        manifestItems.push({
           jobId: manifestId,
           id: folder.id,
           sourceId: folder.originalId || folder.id,
           sourceParentId: context.parentId,
           destParentId: null, // To be filled during migration
           createdDestId: null,
           name: folder.name,
           mimeType: folder.mimeType,
           size: folder.size,
           originalId: folder.originalId || null,
           originalMimeType: folder.originalMimeType || null,
           status: 'PENDING',
           isFolder: true,
           depth: context.depth,
           retryCount: 0
        });
        return { parentId: folder.id, depth: context.depth + 1 }; // child context
      },
      onFile: async (file, context) => {
        totalFiles++;
        totalBytes += file.size;
        
        if (file.size > largestFile) largestFile = file.size;
        
        if (file.mimeType === 'application/vnd.google-apps.document') googleDocs++;
        else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') googleSheets++;
        else if (file.mimeType === 'application/vnd.google-apps.presentation') googleSlides++;
        else if (file.mimeType?.includes('vnd.google-apps') && file.mimeType !== 'application/vnd.google-apps.shortcut') unsupported++;

        const hash = `${file.name}-${file.size}-${file.mimeType}`;
        if (fileHashes.has(hash)) {
          duplicates++;
        } else {
          fileHashes.add(hash);
        }

        manifestItems.push({
           jobId: manifestId,
           id: file.id,
           sourceId: file.originalId || file.id,
           sourceParentId: context.parentId,
           destParentId: null,
           createdDestId: null,
           name: file.name,
           mimeType: file.mimeType,
           size: file.size,
           originalId: file.originalId || null,
           originalMimeType: file.originalMimeType || null,
           status: 'PENDING',
           isFolder: false,
           depth: context.depth,
           retryCount: 0
        });
        
        const summaryObj = { 
          selectedItems: items.length,
          folderCount: totalFolders, 
          fileCount: totalFiles, 
          totalBytes, 
          googleDocs, 
          googleSheets, 
          googleSlides, 
          unsupported, 
          duplicates, 
          largestFile,
          scanStatus: 'Scanning' as const,
          manifestId,
          jobId: manifestId
        };
        await onProgress(totalFolders, totalFiles, totalBytes, `Scanned file: ${file.name}`, summaryObj);
      }
    }, apiWrapper);

    for (const item of items) {
       // Root level items have 'root' as their parent conceptually for the manifest
       await engine.traverseItem(item, { parentId: 'root', depth: 0 });
    }

    const elapsed = Date.now() - startTime;
    console.log(`\nFinal totals:\nFolders: ${totalFolders}\nFiles: ${totalFiles}\nBytes: ${totalBytes}\nElapsed Time: ${elapsed}ms`);

    const persistenceStart = Date.now();
    console.log(`[Backend] Persisting ${manifestItems.length} items to database for manifest: ${manifestId}`);
    
    // Final bulk insert
    await ManifestStorage.saveManifest(manifestItems);
    
    const persistenceElapsed = Date.now() - persistenceStart;
    console.log(`[Backend] Persistence completed in ${persistenceElapsed}ms`);

    const summaryObj = { 
      selectedItems: items.length,
      folderCount: totalFolders, 
      fileCount: totalFiles, 
      totalBytes, 
      googleDocs, 
      googleSheets, 
      googleSlides, 
      unsupported, 
      duplicates, 
      largestFile,
      scanStatus: 'Completed' as const,
      manifestId,
      jobId: manifestId
    };

    // Final update
    await onProgress(totalFolders, totalFiles, totalBytes, 'Complete', summaryObj);

    return summaryObj;
  }
}

export const driveService = new DriveService();
