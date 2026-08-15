import fs from 'fs';
import path from 'path';
import os from 'os';
import { IStorageProvider, StorageDiagnostics } from './StorageProvider';

export class LocalStorageProvider implements IStorageProvider {
  private storagePath: string;

  constructor(customPath?: string) {
    this.storagePath = this.resolveStoragePath(customPath);
  }

  private resolveStoragePath(customPath?: string): string {
    if (customPath && customPath.trim()) {
      return path.isAbsolute(customPath) ? customPath : path.join(process.cwd(), customPath);
    }

    if (process.env.MANIFEST_STORAGE_PATH && process.env.MANIFEST_STORAGE_PATH.trim()) {
      const envPath = process.env.MANIFEST_STORAGE_PATH.trim();
      return path.isAbsolute(envPath) ? envPath : path.join(process.cwd(), envPath);
    }

    const defaultPath = path.join(process.cwd(), 'data', 'manifests');
    try {
      if (!fs.existsSync(defaultPath)) {
        fs.mkdirSync(defaultPath, { recursive: true });
      }
      fs.accessSync(defaultPath, fs.constants.W_OK);
      return defaultPath;
    } catch (_) {
      // Fallback for Docker / Railway / containerized environments where process.cwd() is read-only
      const fallbackPath = path.join(os.tmpdir(), 'googleshift', 'manifests');
      try {
        if (!fs.existsSync(fallbackPath)) {
          fs.mkdirSync(fallbackPath, { recursive: true });
        }
      } catch (_) {}
      return fallbackPath;
    }
  }

  public getProviderName(): string {
    return 'LocalStorageProvider';
  }

  public getStoragePath(): string {
    return this.storagePath;
  }

  public async ensureDirectory(): Promise<boolean> {
    try {
      if (!fs.existsSync(this.storagePath)) {
        await fs.promises.mkdir(this.storagePath, { recursive: true });
      }
      return true;
    } catch (err: any) {
      console.warn(`[LocalStorageProvider] Failed to create primary path ${this.storagePath}: ${err.message}. Attempting fallback to tmpdir...`);
      try {
        this.storagePath = path.join(os.tmpdir(), 'googleshift', 'manifests');
        if (!fs.existsSync(this.storagePath)) {
          await fs.promises.mkdir(this.storagePath, { recursive: true });
        }
        return true;
      } catch (fallbackErr: any) {
        console.error(`[LocalStorageProvider] Fatal: Fallback directory creation failed: ${fallbackErr.message}`);
        return false;
      }
    }
  }

  public getFilePath(filename: string): string {
    const safeFilename = path.basename(filename);
    return path.join(this.storagePath, safeFilename);
  }

  public async exists(filename: string): Promise<boolean> {
    const filePath = this.getFilePath(filename);
    try {
      const stats = await fs.promises.stat(filePath);
      return stats.isFile() && stats.size > 0;
    } catch (_) {
      return false;
    }
  }

  public async append(filename: string, data: string): Promise<void> {
    await this.ensureDirectory();
    const filePath = this.getFilePath(filename);
    await fs.promises.appendFile(filePath, data, 'utf8');
  }

  public async write(filename: string, data: string): Promise<void> {
    await this.ensureDirectory();
    const filePath = this.getFilePath(filename);
    await fs.promises.writeFile(filePath, data, 'utf8');
  }

  public readStream(filename: string): fs.ReadStream | null {
    const filePath = this.getFilePath(filename);
    if (!fs.existsSync(filePath)) return null;
    return fs.createReadStream(filePath, { encoding: 'utf8' });
  }

  public async delete(filename: string): Promise<boolean> {
    const filePath = this.getFilePath(filename);
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        return true;
      }
    } catch (err: any) {
      console.warn(`[LocalStorageProvider] Non-fatal deletion error for ${filePath}:`, err.message);
    }
    return false;
  }

  public async getDiagnostics(): Promise<StorageDiagnostics> {
    const isDirExists = fs.existsSync(this.storagePath);
    let writable = false;
    let readable = false;
    let error: string | undefined;

    try {
      if (isDirExists) {
        const testFile = path.join(this.storagePath, `.perm_test_${Date.now()}`);
        fs.writeFileSync(testFile, 'test', 'utf8');
        writable = true;
        fs.readFileSync(testFile, 'utf8');
        readable = true;
        fs.unlinkSync(testFile);
      }
    } catch (err: any) {
      error = err.message;
    }

    let uid: number | undefined;
    let gid: number | undefined;
    try {
      if (typeof process.getuid === 'function') uid = process.getuid();
      if (typeof process.getgid === 'function') gid = process.getgid();
    } catch (_) {}

    let availableSpaceBytes: number | undefined;
    let freeSpaceFormatted: string | undefined;
    try {
      if (fs.statfsSync) {
        const stats = fs.statfsSync(this.storagePath);
        availableSpaceBytes = Number(stats.bavail) * Number(stats.bsize);
        freeSpaceFormatted = `${(availableSpaceBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
      }
    } catch (_) {}

    return {
      provider: this.getProviderName(),
      path: this.storagePath,
      exists: isDirExists,
      writable,
      readable,
      userUid: uid,
      userGid: gid,
      availableSpaceBytes,
      freeSpaceFormatted,
      error
    };
  }
}

export const defaultStorageProvider = new LocalStorageProvider();
