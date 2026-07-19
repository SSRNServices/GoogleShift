import { ReadStream, WriteStream } from 'fs';
import { PassThrough, Readable, Writable } from 'stream';

export interface FileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  parents?: string[];
}

export interface StorageProvider {
  authenticate(): Promise<string>;
  listFolders(parentId?: string): Promise<FileMetadata[]>;
  listFiles(parentId?: string): Promise<FileMetadata[]>;
  downloadStream(fileId: string): Promise<Readable>;
  uploadStream(folderId: string, name: string, mimeType: string, size?: number): Promise<{ stream: PassThrough; promise: Promise<any> }>;
  createFolder(name: string, parentId?: string): Promise<FileMetadata>;
  findFolder(name: string, parentId?: string): Promise<FileMetadata | null>;
  getQuota(): Promise<{ used: number; limit: number }>;
}
