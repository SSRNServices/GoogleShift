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
  private async getDriveClient(sessionId: string, type: AccountType): Promise<drive_v3.Drive> {
    const auth = await googleClientManager.getAuthenticatedClient(sessionId, type);
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

  public async getFolderContents(sessionId: string, type: AccountType, folderId: string, pageToken?: string) {
    const drive = await this.getDriveClient(sessionId, type);
    
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

  public async search(sessionId: string, type: AccountType, query: string, pageToken?: string) {
    const drive = await this.getDriveClient(sessionId, type);
    
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

  public async getSharedWithMe(sessionId: string, type: AccountType, pageToken?: string) {
    const drive = await this.getDriveClient(sessionId, type);
    
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

  public async getRecent(sessionId: string, type: AccountType, pageToken?: string) {
    const drive = await this.getDriveClient(sessionId, type);
    
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

  public async getStarred(sessionId: string, type: AccountType, pageToken?: string) {
    const drive = await this.getDriveClient(sessionId, type);
    
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

  public async createFolder(sessionId: string, type: AccountType, name: string, parentId?: string) {
    const drive = await this.getDriveClient(sessionId, type);
    
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
  
  public async getFolderInfo(sessionId: string, type: AccountType, folderId: string) {
    const drive = await this.getDriveClient(sessionId, type);
    const res = await drive.files.get({
        fileId: folderId === 'root' ? 'root' : folderId,
        fields: 'id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents, shortcutDetails'
    });
    
    // If it's root, the name might just be 'My Drive' or something similar.
    return this.mapFile(res.data);
  }

  public async getRoot(sessionId: string, type: AccountType, pageToken?: string) {
    const drive = await this.getDriveClient(sessionId, type);
    
    // 1. Fetch real root metadata
    const rootMetaRes = await drive.files.get({
      fileId: 'root',
      fields: 'id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents, shortcutDetails'
    });
    
    // 2. Fetch root children
    const contents = await this.getFolderContents(sessionId, type, 'root', pageToken);

    return {
      folder: this.mapFile(rootMetaRes.data),
      files: contents.files,
      nextPageToken: contents.nextPageToken
    };
  }

  public async getSelectionSummary(
    sessionId: string,
    type: AccountType, 
    items: { id: string, isFolder: boolean }[], 
    onProgress: (folders: number, files: number, bytes: number, currentAction: string) => void
  ) {
    const drive = await this.getDriveClient(sessionId, type);
    
    let totalFolders = 0;
    let totalFiles = 0;
    let totalBytes = 0;

    const manifestId = 'manifest_' + Date.now();
    const startTime = Date.now();
    console.log(`[Backend] Recursive scan started for ${type} account, ${items.length} items. Manifest: ${manifestId}`);

    const { DriveTraversalEngine } = await import('./DriveTraversalEngine');
    const { ManifestStorage } = await import('../utils/ManifestStorage');
    const { RetryHelper } = await import('../utils/retry');
    
    const apiWrapper = async <T>(name: string, op: () => Promise<T>): Promise<T> => {
       return RetryHelper.withRetry(name, op, (msg) => console.log(msg));
    };

    const engine = new DriveTraversalEngine<{ parentId: string, depth: number }>(drive, {
      onFolderEnter: async (folder, context) => {
        totalFolders++;
        await ManifestStorage.insertItem({
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
           depth: context.depth
        });
        return { parentId: folder.id, depth: context.depth + 1 }; // child context
      },
      onFile: async (file, context) => {
        totalFiles++;
        totalBytes += file.size;
        await ManifestStorage.insertItem({
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
           depth: context.depth
        });
        onProgress(totalFolders, totalFiles, totalBytes, `Scanned file: ${file.name}`);
      }
    }, apiWrapper);

    for (const item of items) {
       // Root level items have 'root' as their parent conceptually for the manifest
       await engine.traverseItem(item, { parentId: 'root', depth: 0 });
    }

    const elapsed = Date.now() - startTime;
    console.log(`\nFinal totals:\nFolders: ${totalFolders}\nFiles: ${totalFiles}\nBytes: ${totalBytes}\nElapsed Time: ${elapsed}ms`);

    // Final update
    onProgress(totalFolders, totalFiles, totalBytes, 'Complete');

    return {
      manifestId,
      folders: totalFolders,
      files: totalFiles,
      bytes: totalBytes
    };
  }
}

export const driveService = new DriveService();
