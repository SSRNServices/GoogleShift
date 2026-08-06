import { driveService } from './DriveService';
import { MimeClassifier, MimeStatsPayload } from './MimeClassifier';
import { StorageAnalyzer } from './StorageAnalyzer';
import { ManifestStorage } from '../utils/ManifestStorage';
import { DriveTraversalEngine } from './DriveTraversalEngine';
import { RetryHelper } from '../utils/retry';
import { prisma } from '../utils/database';
import { AccountType } from '../auth/token.store';

export interface DiscoveryOptions {
  userId: string;
  type: AccountType;
  items: { id: string; isFolder: boolean }[];
  manifestId: string;
  onProgress: (event: string, data: any) => Promise<void> | void;
}

export class DiscoveryService {
  public static async executeDiscovery(options: DiscoveryOptions) {
    const { userId, type, items, manifestId, onProgress } = options;
    console.log(`[DISCOVERY] Loading OAuth and creating Google Drive client for userId=${userId}, type=${type}...`);
    const drive = await driveService.getDriveClient(userId, type);
    console.log(`[DISCOVERY] Google Drive client created successfully.`);
    
    let totalFolders = 0;
    let totalFiles = 0;
    let totalBytes = 0;
    let largestFile = 0;
    let googleRequests = 0;
    
    const mimeStats: MimeStatsPayload = {
      googleDocs: 0, googleSheets: 0, googleSlides: 0,
      pdf: 0, images: 0, videos: 0, archives: 0,
      unsupported: 0, duplicates: 0, other: 0
    };
    
    const warnings: { type: string; message: string; fileId?: string; fileName?: string }[] = [];
    const fileHashes = new Set<string>();

    console.log(`[DISCOVERY] Starting discovery traversal for ${items.length} top-level item(s). Manifest ID: ${manifestId}`);
    await onProgress('SCAN_STARTED', { message: 'Initializing Discovery Phase...', googleRequests });
    
    const manifestItems: any[] = [];
    let lastEventTime = Date.now();
    
    const engine = new DriveTraversalEngine<{ parentId: string, depth: number }>(drive, {
      onFolderEnter: async (folder, context) => {
        totalFolders++;
        console.log(`[DISCOVERY] Entering Folder: "${folder.name}" (${folder.id}) | Total Folders: ${totalFolders}, Files: ${totalFiles}, Size: ${totalBytes} B`);
        manifestItems.push({
           jobId: manifestId,
           id: folder.id,
           sourceId: folder.originalId || folder.id,
           sourceParentId: context.parentId,
           destParentId: null,
           createdDestId: null,
           name: folder.name,
           mimeType: folder.mimeType,
           size: folder.size,
           originalId: folder.originalId || null,
           originalMimeType: folder.originalMimeType || null,
           status: 'PENDING',
           isFolder: true,
           depth: context.depth,
           retryCount: 0
        });
        
        await onProgress('SCAN_FOLDER', { 
          folderName: folder.name, 
          totalFolders, 
          totalFiles, 
          totalBytes,
          googleRequests 
        });
        return { parentId: folder.id, depth: context.depth + 1 };
      },
      onFile: async (file, context) => {
        totalFiles++;
        totalBytes += file.size;
        
        if (file.size > largestFile) largestFile = file.size;
        
        const classification = MimeClassifier.classify(file.mimeType);
        mimeStats[classification]++;
        
        if (classification === 'unsupported') {
           warnings.push({ type: 'UNSUPPORTED_MIME', message: `Unsupported file type: ${file.mimeType}`, fileId: file.id, fileName: file.name });
        }
        
        if (file.size > 10 * 1024 * 1024 * 1024) { // 10 GB limit warning
           warnings.push({ type: 'LARGE_FILE', message: `Extremely large file detected: ${(file.size / 1e9).toFixed(2)} GB`, fileId: file.id, fileName: file.name });
        }

        const hash = `${file.name}-${file.size}-${file.mimeType}`;
        if (fileHashes.has(hash)) {
          mimeStats.duplicates++;
          warnings.push({ type: 'DUPLICATE_NAME', message: `Duplicate file detected: ${file.name}`, fileId: file.id, fileName: file.name });
        } else {
          fileHashes.add(hash);
        }

        manifestItems.push({
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
           depth: context.depth,
           retryCount: 0
        });
        
        const now = Date.now();
        if (now - lastEventTime > 100) {
          lastEventTime = now;
          await onProgress('SCAN_PROGRESS', {
             currentFile: file.name,
             totalFolders, totalFiles, totalBytes, googleRequests
          });
        }
      }
    }, async (name, op) => {
      googleRequests++;
      return RetryHelper.withRetry(name, op, (msg) => console.log(`[DISCOVERY] ${msg}`));
    });

    for (const item of items) {
       console.log(`[DISCOVERY] Scanning root item ID: ${item.id}, isFolder: ${item.isFolder}`);
       await engine.traverseItem(item, { parentId: 'root', depth: 0 });
    }

    console.log(`[DISCOVERY] Drive traversal complete. Discovered ${totalFolders} folders, ${totalFiles} files (${totalBytes} B) across ${googleRequests} API requests.`);
    await onProgress('MANIFEST_UPDATED', { message: 'Analyzing destination storage...', googleRequests });
    
    // Analyze Storage Requirements
    const storageAnalysis = await StorageAnalyzer.analyzeStorage(userId, totalBytes);
    
    if (!storageAnalysis.sufficient) {
       warnings.push(...storageAnalysis.warnings.map(w => ({ type: 'STORAGE_EXHAUSTION', message: w })));
    }

    console.log(`[DISCOVERY] Persisting ${manifestItems.length} manifest items to database...`);
    await onProgress('MANIFEST_UPDATED', { message: 'Persisting manifest to database...', googleRequests });
    
    await ManifestStorage.saveManifest(manifestItems);
    
    // Persist new Summary tables idempotently
    await prisma.scanSummary.upsert({
      where: { manifestId },
      create: {
        manifestId,
        totalFolders,
        totalFiles,
        totalBytes,
        destinationStorageLimit: storageAnalysis.limit,
        destinationStorageUsed: storageAnalysis.used,
        estimatedTimeSeconds: storageAnalysis.estimatedTimeSeconds,
        largestFile,
        mimeStats: {
          create: mimeStats
        },
        warnings: {
          create: warnings
        }
      },
      update: {
        totalFolders,
        totalFiles,
        totalBytes,
        destinationStorageLimit: storageAnalysis.limit,
        destinationStorageUsed: storageAnalysis.used,
        estimatedTimeSeconds: storageAnalysis.estimatedTimeSeconds,
        largestFile
      }
    });

    const finalSummary = {
       scanStatus: 'Completed' as const,
       manifestId,
       jobId: manifestId,
       totalFolders,
       totalFiles,
       totalBytes,
       googleRequests,
       storageAnalysis,
       mimeStats,
       warnings,
       largestFile
    };

    console.log(`[DISCOVERY] Discovery Finished successfully for manifestId=${manifestId}`);
    await onProgress('SCAN_COMPLETED', finalSummary);
    return finalSummary;
  }
}
