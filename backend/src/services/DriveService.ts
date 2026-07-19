import { google, drive_v3 } from 'googleapis';
import { oauthService, AccountType } from '../oauth/OAuthService';
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
  private getDriveClient(type: AccountType): drive_v3.Drive {
    const auth = oauthService.getAuthenticatedClient(type);
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
    };
  }

  public async getFolderContents(type: AccountType, folderId: string, pageToken?: string) {
    const drive = this.getDriveClient(type);
    
    // Resolve 'root' to the actual root ID
    const queryId = folderId === 'root' ? 'root' : folderId;

    const res = await drive.files.list({
      q: `'${queryId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents)',
      orderBy: 'folder, name',
      pageSize: 50,
      pageToken: pageToken,
    });

    return {
      files: (res.data.files || []).map(this.mapFile),
      nextPageToken: res.data.nextPageToken,
    };
  }

  public async search(type: AccountType, query: string, pageToken?: string) {
    const drive = this.getDriveClient(type);
    
    const res = await drive.files.list({
      q: `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents)',
      orderBy: 'folder, name',
      pageSize: 50,
      pageToken: pageToken,
    });

    return {
      files: (res.data.files || []).map(this.mapFile),
      nextPageToken: res.data.nextPageToken,
    };
  }

  public async getSharedWithMe(type: AccountType, pageToken?: string) {
    const drive = this.getDriveClient(type);
    
    const res = await drive.files.list({
      q: `sharedWithMe = true and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents)',
      orderBy: 'folder, name',
      pageSize: 50,
      pageToken: pageToken,
    });

    return {
      files: (res.data.files || []).map(this.mapFile),
      nextPageToken: res.data.nextPageToken,
    };
  }

  public async getRecent(type: AccountType, pageToken?: string) {
    const drive = this.getDriveClient(type);
    
    const res = await drive.files.list({
      q: `trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents)',
      orderBy: 'modifiedTime desc',
      pageSize: 50,
      pageToken: pageToken,
    });

    return {
      files: (res.data.files || []).map(this.mapFile),
      nextPageToken: res.data.nextPageToken,
    };
  }

  public async getStarred(type: AccountType, pageToken?: string) {
    const drive = this.getDriveClient(type);
    
    const res = await drive.files.list({
      q: `starred = true and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents)',
      orderBy: 'folder, name',
      pageSize: 50,
      pageToken: pageToken,
    });

    return {
      files: (res.data.files || []).map(this.mapFile),
      nextPageToken: res.data.nextPageToken,
    };
  }

  public async createFolder(type: AccountType, name: string, parentId?: string) {
    const drive = this.getDriveClient(type);
    
    const fileMetadata: any = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
    };
    
    if (parentId && parentId !== 'root') {
      fileMetadata.parents = [parentId];
    }

    const res = await drive.files.create({
      requestBody: fileMetadata,
      fields: 'id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents',
    });

    return this.mapFile(res.data);
  }
  
  public async getFolderInfo(type: AccountType, folderId: string) {
    const drive = this.getDriveClient(type);
    const res = await drive.files.get({
        fileId: folderId === 'root' ? 'root' : folderId,
        fields: 'id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents'
    });
    
    // If it's root, the name might just be 'My Drive' or something similar.
    return this.mapFile(res.data);
  }

  public async getRoot(type: AccountType, pageToken?: string) {
    const drive = this.getDriveClient(type);
    
    // 1. Fetch real root metadata
    const rootMetaRes = await drive.files.get({
      fileId: 'root',
      fields: 'id, name, mimeType, size, modifiedTime, createdTime, owners, iconLink, thumbnailLink, parents'
    });
    
    // 2. Fetch root children
    const contents = await this.getFolderContents(type, 'root', pageToken);

    return {
      folder: this.mapFile(rootMetaRes.data),
      files: contents.files,
      nextPageToken: contents.nextPageToken
    };
  }

  public async getSelectionSummary(
    type: AccountType, 
    items: { id: string, isFolder: boolean }[], 
    onProgress: (folders: number, files: number, bytes: number, currentAction: string) => void
  ) {
    const drive = this.getDriveClient(type);
    
    let totalFolders = 0;
    let totalFiles = 0;
    let totalBytes = 0;

    const startTime = Date.now();
    console.log(`[Backend] Recursive scan started for ${type} account, ${items.length} items`);

    const visited = new Set<string>();
    const limit = pLimit(5); // Limit API calls, not the recursion itself

    let activeRecursion = 0;

    const scanFolder = async (folderId: string, folderName: string, depth: number) => {
      activeRecursion++;
      const pendingAsyncCount = limit.activeCount || 0;
      console.log(`[ENTER] folder id: ${folderId} | name: ${folderName} | depth: ${depth} | visited count: ${visited.size} | pending async count: ${pendingAsyncCount}`);

      try {
        // Resolve root ID
        if (folderId === 'root') {
          const rootRes = await limit(() => drive.files.get({ fileId: 'root', fields: 'id' }));
          folderId = rootRes.data.id || 'root';
        }

        if (visited.has(folderId)) {
          console.log(`[SKIPPED] already visited folder id: ${folderId}`);
          return;
        }
        visited.add(folderId);

        onProgress(totalFolders, totalFiles, totalBytes, `Scanning folder: ${folderName}...`);

        let pageToken: string | undefined = undefined;

        do {
          const currentPageToken = pageToken;
          if (currentPageToken) {
             console.log(`current page token: ${currentPageToken}`);
          }

          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('HUNG RECURSION')), 30000));
          const apiPromise = limit(() => drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'nextPageToken, files(id, name, mimeType, size)',
            pageSize: 1000,
            pageToken: pageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          }));

          let res: any;
          try {
            res = await Promise.race([apiPromise, timeoutPromise]);
          } catch (error: any) {
             if (error.message === 'HUNG RECURSION') {
                console.log(`[HUNG RECURSION] folder id: ${folderId} | name: ${folderName} | current depth: ${depth}`);
             }
             throw error;
          }

          const files = res.data.files || [];
          console.log(`returned items: ${files.length} | next page token: ${res.data.nextPageToken || 'none'}`);
          
          const subfolderPromises: Promise<void>[] = [];

          for (const file of files) {
            if (file.mimeType === 'application/vnd.google-apps.folder') {
              console.log(`[CHILD] folder: ${file.name}`);
              totalFolders++;
              if (file.id) {
                // Do not wrap the recursion with limit!
                subfolderPromises.push(scanFolder(file.id, file.name || 'Unknown Folder', depth + 1));
              }
            } else if (file.mimeType === 'application/vnd.google-apps.shortcut') {
              console.log(`[CHILD] shortcut: ${file.name}`);
            } else if (file.mimeType === 'application/vnd.google-apps.document' || file.mimeType === 'application/vnd.google-apps.spreadsheet' || file.mimeType === 'application/vnd.google-apps.presentation') {
              console.log(`[CHILD] Google Doc: ${file.name}`);
              totalFiles++;
              // size is estimated as 0
            } else {
              console.log(`[CHILD] file: ${file.name}`);
              totalFiles++;
              if (file.size) {
                totalBytes += parseInt(file.size, 10);
              }
            }
          }

          onProgress(totalFolders, totalFiles, totalBytes, `Scanning folder: ${folderName}... (Found ${files.length} items)`);
          
          if (subfolderPromises.length > 0) {
            console.log(`waiting for ${subfolderPromises.length} promises (depth: ${depth})`);
            await Promise.all(subfolderPromises);
            console.log(`completed Promise.all for ${subfolderPromises.length} promises (depth: ${depth})`);
          }

          const npt = res.data.nextPageToken || undefined;
          if (pageToken && npt === pageToken) {
             console.error(`[ABORT] Identical page token repeated: ${npt}`);
             break;
          }
          pageToken = npt;

        } while (pageToken);
      } finally {
        activeRecursion--;
        console.log(`[LEAVE] folder id: ${folderId} | name: ${folderName} | depth: ${depth}`);
      }
    };

    for (const item of items) {
      if (item.isFolder) {
        totalFolders++; // Count the root selected folder itself
        const meta = await limit(() => drive.files.get({ fileId: item.id === 'root' ? 'root' : item.id, fields: 'name' }));
        await scanFolder(item.id, meta.data.name || 'Folder', 0);
      } else {
        totalFiles++;
        const meta = await limit(() => drive.files.get({ fileId: item.id, fields: 'size, name' }));
        if (meta.data.size) {
          totalBytes += parseInt(meta.data.size, 10);
        }
        onProgress(totalFolders, totalFiles, totalBytes, `Scanned file: ${meta.data.name}`);
      }
    }

    if (activeRecursion !== 0) {
       console.error(`[WARNING] active recursion == ${activeRecursion} (expected 0)`);
    }

    const elapsed = Date.now() - startTime;
    console.log(`\nSCAN COMPLETE\nFolders: ${totalFolders}\nFiles: ${totalFiles}\nBytes: ${totalBytes}\nElapsed Time: ${elapsed}ms\nVisited folders: ${visited.size}`);

    // Final update
    onProgress(totalFolders, totalFiles, totalBytes, 'Complete');

    return {
      folders: totalFolders,
      files: totalFiles,
      bytes: totalBytes
    };
  }
}

export const driveService = new DriveService();
