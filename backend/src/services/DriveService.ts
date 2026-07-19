import { google, drive_v3 } from 'googleapis';
import { oauthService, AccountType } from '../oauth/OAuthService';

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
}

export const driveService = new DriveService();
