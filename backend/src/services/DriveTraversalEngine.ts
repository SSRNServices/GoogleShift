import { drive_v3 } from 'googleapis';
import { pLimit } from '../utils/pLimit';
import { DriveResolver, ResolvedDriveItem, ApiWrapper } from './DriveResolver';

export interface TraversalStrategy<TContext> {
  onFolderEnter: (folder: ResolvedDriveItem, context: TContext) => Promise<TContext | 'skip'>;
  onFile: (file: ResolvedDriveItem, context: TContext) => Promise<void>;
}

export interface TraversalStrategy<TContext> {
  onFolderEnter: (folder: ResolvedDriveItem, context: TContext) => Promise<TContext | 'skip'>;
  onFile: (file: ResolvedDriveItem, context: TContext) => Promise<void>;
}

export interface FolderTask<TContext> {
  id: string;
  name: string;
  depth: number;
  context: TContext;
}

export class DriveTraversalEngine<TContext> {
  private visited = new Set<string>();
  // High-performance concurrency limit for Google Drive API listing tasks (12 concurrent worker calls)
  private limit = pLimit(12);

  public apiRequests = 0;
  public apiTimeMs = 0;
  
  constructor(
    private drive: drive_v3.Drive,
    private strategy: TraversalStrategy<TContext>,
    private apiWrapper: ApiWrapper
  ) {}

  public async traverseItem(
    item: { id: string, isFolder: boolean, name?: string },
    initialContext: TContext
  ): Promise<void> {
    const startItemTime = Date.now();
    console.log(`[DISCOVERY] Resolving initial item ID: ${item.id} (${item.name || 'Root'})`);
    
    const resolved = await DriveResolver.resolveItem(
      this.drive,
      item.id,
      this.apiWrapper,
      item.name
    );

    if (resolved.mimeType === 'application/vnd.google-apps.folder') {
       if (!this.visited.has(resolved.id)) {
          this.visited.add(resolved.id);
          
          const forbidden = ['node_modules', '.git', 'venv', 'dist', 'backend', 'frontend'];
          if (forbidden.includes(resolved.name)) {
             throw new Error(`InvalidScanSourceException: Scanner attempted to scan local filesystem path or forbidden directory "${resolved.name}" instead of Google Drive.`);
          }

          const newContext = await this.strategy.onFolderEnter(resolved, initialContext);
          if (newContext !== 'skip') {
             const rootTask: FolderTask<TContext> = {
               id: resolved.id,
               name: resolved.name || 'Root',
               depth: 0,
               context: newContext
             };
             await this.processBfsQueue([rootTask]);
          }
       }
    } else {
       await this.strategy.onFile(resolved, initialContext);
    }

    console.log(`[DISCOVERY] Item traversal complete for ${item.id} in ${Date.now() - startItemTime}ms.`);
  }

  /**
   * High-throughput Iterative BFS Queue Engine
   * Concurrently processes folders up to concurrencyLimit = 12
   */
  private async processBfsQueue(initialTasks: FolderTask<TContext>[]): Promise<void> {
    const queue: FolderTask<TContext>[] = [...initialTasks];
    
    let activeWorkers = 0;
    
    return new Promise((resolve, reject) => {
      const checkAndRunNext = () => {
        if (queue.length === 0 && activeWorkers === 0) {
          return resolve();
        }

        while (queue.length > 0 && activeWorkers < 12) {
          const task = queue.shift()!;
          activeWorkers++;

          this.scanFolderBfs(task)
            .then((newTasks) => {
              for (const nt of newTasks) {
                queue.push(nt);
              }
            })
            .catch((err) => {
              console.error(`[DISCOVERY] Error scanning folder "${task.name}" (${task.id}):`, err.message);
              // Reject on fatal errors
              reject(err);
            })
            .finally(() => {
              activeWorkers--;
              checkAndRunNext();
            });
        }
      };

      checkAndRunNext();
    });
  }

  private async scanFolderBfs(task: FolderTask<TContext>): Promise<FolderTask<TContext>[]> {
    const newTasks: FolderTask<TContext>[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const startTime = Date.now();
      this.apiRequests++;

      const res: any = await this.limit(() => this.apiWrapper(`List Children ${task.id}`, () => this.drive.files.list({
        q: `'${task.id}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, parents, shortcutDetails(targetId, targetMimeType))',
        pageSize: 1000,
        pageToken: pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }, { timeout: 20000 })));

      const reqElapsed = Date.now() - startTime;
      this.apiTimeMs += reqElapsed;

      const files = res.data?.files || [];

      for (const file of files) {
        let fileId = file.id;
        let mimeType = file.mimeType;
        let name = file.name || 'Untitled';
        let size = file.size ? parseInt(file.size, 10) : 0;
        
        let originalId: string | undefined = undefined;
        let originalMimeType: string | undefined = undefined;

        // Fast in-memory shortcut resolution without extra API calls
        if (mimeType === 'application/vnd.google-apps.shortcut' && file.shortcutDetails?.targetId) {
           originalId = fileId;
           originalMimeType = mimeType;
           fileId = file.shortcutDetails.targetId;
           mimeType = file.shortcutDetails.targetMimeType || mimeType;
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
            
            const newContext = await this.strategy.onFolderEnter(resolvedItem, task.context);
            if (newContext !== 'skip') {
               newTasks.push({
                 id: fileId,
                 name,
                 depth: task.depth + 1,
                 context: newContext
               });
            }
          }
        } else {
           await this.strategy.onFile(resolvedItem, task.context);
        }
      }

      const npt = res.data?.nextPageToken || undefined;
      if (pageToken && npt === pageToken) {
         console.error(`[DISCOVERY] Aborting page loop for ${task.id} — Identical page token repeated: ${npt}`);
         break;
      }
      pageToken = npt;

    } while (pageToken);

    return newTasks;
  }
}
