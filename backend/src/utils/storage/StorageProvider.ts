import fs from 'fs';

export interface StorageDiagnostics {
  provider: string;
  path: string;
  exists: boolean;
  writable: boolean;
  readable: boolean;
  userUid?: number;
  userGid?: number;
  error?: string;
}

export interface IStorageProvider {
  getProviderName(): string;
  getStoragePath(): string;
  ensureDirectory(): Promise<boolean>;
  getFilePath(filename: string): string;
  exists(filename: string): Promise<boolean>;
  append(filename: string, data: string): Promise<void>;
  write(filename: string, data: string): Promise<void>;
  readStream(filename: string): fs.ReadStream | null;
  delete(filename: string): Promise<boolean>;
  getDiagnostics(): Promise<StorageDiagnostics>;
}
