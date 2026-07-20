import { drive_v3 } from 'googleapis';

export interface ResolvedDriveItem {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  originalId?: string;
  originalMimeType?: string;
}

export type ApiWrapper = <T>(name: string, op: () => Promise<T>) => Promise<T>;

export class DriveResolver {
  public static async resolveItem(
    drive: drive_v3.Drive,
    itemId: string,
    apiWrapper: ApiWrapper,
    fallbackName: string = 'Unknown'
  ): Promise<ResolvedDriveItem> {
    let actualId = itemId;
    let name = fallbackName;
    let mimeType = '';
    let size = 0;
    
    // Resolve root first if necessary
    if (actualId === 'root') {
      const rootRes = await apiWrapper('Get Root ID', () => drive.files.get({
        fileId: 'root',
        fields: 'id',
        supportsAllDrives: true
      }));
      actualId = rootRes.data.id || 'root';
    }

    const meta = await apiWrapper(`Resolve Metadata ${actualId}`, () => drive.files.get({
      fileId: actualId,
      fields: 'id, name, mimeType, size, shortcutDetails',
      supportsAllDrives: true
    }));

    name = meta.data.name || name;
    mimeType = meta.data.mimeType || '';
    if (meta.data.size) {
      size = parseInt(meta.data.size, 10);
    }

    let originalId: string | undefined = undefined;
    let originalMimeType: string | undefined = undefined;

    if (mimeType === 'application/vnd.google-apps.shortcut' && meta.data.shortcutDetails) {
      originalId = actualId;
      originalMimeType = mimeType;
      
      actualId = meta.data.shortcutDetails.targetId || actualId;
      mimeType = meta.data.shortcutDetails.targetMimeType || mimeType;

      console.log(`[RESOLVER] Resolved shortcut ${originalId} -> Target ${actualId} (${mimeType})`);

      // Note: we don't recursively get the target's size right now. 
      // If it's a file, size will be reported as 0 initially.
      // But we can fetch it if it's a file.
      if (mimeType !== 'application/vnd.google-apps.folder') {
         try {
            const targetMeta = await apiWrapper(`Resolve Target Size ${actualId}`, () => drive.files.get({
              fileId: actualId,
              fields: 'size',
              supportsAllDrives: true
            }));
            if (targetMeta.data.size) {
              size = parseInt(targetMeta.data.size, 10);
            }
         } catch (e: any) {
            console.log(`[DriveResolver] Failed to fetch shortcut target size for ${actualId}:`, e.message);
         }
      }
    }

    // Google workspace files natively consume 0 bytes
    if (mimeType === 'application/vnd.google-apps.document' || 
        mimeType === 'application/vnd.google-apps.spreadsheet' || 
        mimeType === 'application/vnd.google-apps.presentation') {
      size = 0;
    }

    return {
      id: actualId,
      name,
      mimeType,
      size,
      originalId,
      originalMimeType
    };
  }
}
