import { google, drive_v3 } from 'googleapis';
import { StorageProvider, FileMetadata } from './StorageProvider';
import { PassThrough, Readable } from 'stream';
import { OAuth2Client } from 'google-auth-library';

export class GoogleDriveProvider implements StorageProvider {
  private drive: drive_v3.Drive;
  
  constructor(private oauthClient: OAuth2Client) {
    this.drive = google.drive({ version: 'v3', auth: this.oauthClient });
  }

  async authenticate(): Promise<string> {
    return 'authenticated'; // Handled outside via OAuth
  }

  async listFolders(parentId?: string): Promise<FileMetadata[]> {
    const q = `mimeType='application/vnd.google-apps.folder' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`;
    const res = await this.drive.files.list({
      q,
      fields: 'files(id, name, mimeType, parents)',
      pageSize: 1000
    });
    return res.data.files as FileMetadata[] || [];
  }

  async listFiles(parentId?: string): Promise<FileMetadata[]> {
    const q = `mimeType!='application/vnd.google-apps.folder' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`;
    const res = await this.drive.files.list({
      q,
      fields: 'files(id, name, mimeType, size, parents)',
      pageSize: 1000
    });
    return (res.data.files as FileMetadata[]) || [];
  }

  async downloadStream(fileId: string): Promise<Readable> {
    const res = await this.drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    return res.data;
  }

  async uploadStream(folderId: string, name: string, mimeType: string, size?: number): Promise<{ stream: PassThrough; promise: Promise<any> }> {
    const pass = new PassThrough();
    
    const promise = this.drive.files.create({
      requestBody: {
        name,
        parents: folderId ? [folderId] : undefined
      },
      media: {
        mimeType,
        body: pass
      },
      fields: 'id'
    });

    return { stream: pass, promise };
  }

  async createFolder(name: string, parentId?: string): Promise<FileMetadata> {
    const res = await this.drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : undefined
      },
      fields: 'id, name, mimeType, parents'
    });
    return res.data as FileMetadata;
  }

  async findFolder(name: string, parentId?: string): Promise<FileMetadata | null> {
    const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`;
    const res = await this.drive.files.list({
      q,
      fields: 'files(id, name, mimeType, parents)',
      pageSize: 1
    });
    const files = res.data.files;
    return files && files.length > 0 ? (files[0] as FileMetadata) : null;
  }

  async getQuota(): Promise<{ used: number; limit: number }> {
    const res = await this.drive.about.get({ fields: 'storageQuota' });
    const quota = res.data.storageQuota;
    return {
      used: parseInt(quota?.usage || '0', 10),
      limit: parseInt(quota?.limit || '0', 10)
    };
  }
}
