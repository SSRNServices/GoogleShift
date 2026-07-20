import { drive_v3 } from 'googleapis';
import { pLimit } from '../utils/pLimit';
import { DriveResolver, ResolvedDriveItem, ApiWrapper } from './DriveResolver';

export interface TraversalStrategy<TContext> {
  onFolderEnter: (folder: ResolvedDriveItem, context: TContext) => Promise<TContext | 'skip'>;
  onFile: (file: ResolvedDriveItem, context: TContext) => Promise<void>;
}

export class DriveTraversalEngine<TContext> {
  private visited = new Set<string>();
  // Concurrent fetching of folders via pLimit
  private limit = pLimit(5);
  
  constructor(
    private drive: drive_v3.Drive,
    private strategy: TraversalStrategy<TContext>,
    private apiWrapper: ApiWrapper
  ) {}

  public async traverseItem(
    item: { id: string, isFolder: boolean, name?: string },
    initialContext: TContext
  ): Promise<void> {
    const resolved = await DriveResolver.resolveItem(
      this.drive,
      item.id,
      this.apiWrapper,
      item.name
    );

    if (resolved.mimeType === 'application/vnd.google-apps.folder') {
       if (!this.visited.has(resolved.id)) {
          this.visited.add(resolved.id);
          
          const newContext = await this.strategy.onFolderEnter(resolved, initialContext);
          if (newContext !== 'skip') {
             await this.scanFolder(resolved.id, resolved.name, 0, newContext);
          }
       }
    } else {
       await this.strategy.onFile(resolved, initialContext);
    }
  }

  private async scanFolder(
    folderId: string, 
    folderName: string, 
    depth: number, 
    context: TContext
  ): Promise<void> {
    let pageToken: string | undefined = undefined;

    do {
      const apiPromise = this.limit(() => this.apiWrapper(`List Children ${folderId}`, () => this.drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, shortcutDetails)',
        pageSize: 1000,
        pageToken: pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })));

      const res: any = await apiPromise;
      const files = res.data.files || [];
      
      if (pageToken === undefined) {
         console.log(`Entering folder:\nFolder ID: ${folderId}\nFolder Name: ${folderName}\nChild count: ${files.length} (first page)`);
      }
      console.log(`Recursion call:\nCurrent depth: ${depth}\nParent: ${folderId}\nChildren returned: ${files.length}`);

      const subfolderPromises: Promise<void>[] = [];

      for (const file of files) {
        let fileId = file.id;
        let mimeType = file.mimeType;
        let name = file.name;
        let size = file.size ? parseInt(file.size, 10) : 0;
        
        let originalId: string | undefined = undefined;
        let originalMimeType: string | undefined = undefined;

        if (mimeType === 'application/vnd.google-apps.shortcut') {
           if (file.shortcutDetails?.targetId) {
              originalId = fileId;
              originalMimeType = mimeType;
              fileId = file.shortcutDetails.targetId;
              mimeType = file.shortcutDetails.targetMimeType;
              
              if (mimeType !== 'application/vnd.google-apps.folder') {
                 // Try to resolve target size
                 try {
                    const targetMeta = await this.apiWrapper(`Resolve Target Size ${fileId}`, () => this.drive.files.get({
                      fileId: fileId as string,
                      fields: 'size',
                      supportsAllDrives: true
                    }));
                    if (targetMeta.data.size) {
                      size = parseInt(targetMeta.data.size, 10);
                    }
                 } catch (e: any) {
                    console.log(`[DriveTraversal] Failed to fetch shortcut target size for ${fileId}:`, e.message);
                 }
              }
           }
        }
        
        if (mimeType === 'application/vnd.google-apps.document' || 
            mimeType === 'application/vnd.google-apps.spreadsheet' || 
            mimeType === 'application/vnd.google-apps.presentation') {
          size = 0;
        }

        const resolvedItem: ResolvedDriveItem = {
           id: fileId,
           name,
           mimeType,
           size,
           originalId,
           originalMimeType
        };

        if (mimeType === 'application/vnd.google-apps.folder') {
          if (fileId && !this.visited.has(fileId)) {
            this.visited.add(fileId);
            
            // Execute onFolderEnter synchronously to avoid race conditions and maintain ordering
            const newContext = await this.strategy.onFolderEnter(resolvedItem, context);
            if (newContext !== 'skip') {
               // Push recursive scan to promises
               subfolderPromises.push(this.scanFolder(fileId, name || 'Unknown Folder', depth + 1, newContext));
            }
          }
        } else {
           // We await file processing sequentially to avoid overwhelming sockets, exactly as user instructed
           await this.strategy.onFile(resolvedItem, context);
        }
      }

      if (subfolderPromises.length > 0) {
        await Promise.all(subfolderPromises);
      }

      const npt = res.data.nextPageToken || undefined;
      if (pageToken && npt === pageToken) {
         console.error(`[ABORT] Identical page token repeated: ${npt}`);
         break;
      }
      pageToken = npt;

    } while (pageToken);
  }
}
