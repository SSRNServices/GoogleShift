import { driveService } from './DriveService';
import { MimeClassifier, MimeStatsPayload } from './MimeClassifier';
import { StorageAnalyzer } from './StorageAnalyzer';
import { ManifestStorage } from '../utils/ManifestStorage';
import { DriveTraversalEngine } from './DriveTraversalEngine';
import { RetryHelper } from '../utils/retry';
import { prisma } from '../utils/database';
import { AccountType } from '../auth/token.store';
import { pLimit } from '../utils/pLimit';

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
    const startTime = Date.now();

    console.log(`[DISCOVERY] Loading OAuth and creating Google Drive client for userId=${userId}, type=${type}...`);
    const drive = await driveService.getDriveClient(userId, type);
    console.log(`[DISCOVERY] Google Drive client created successfully.`);
    
    let totalFolders = 0;
    let totalFiles = 0;
    let totalBytes = 0;
    let largestFile = 0;
    
    const mimeStats: MimeStatsPayload = {
      googleDocs: 0, googleSheets: 0, googleSlides: 0,
      pdf: 0, images: 0, videos: 0, archives: 0,
      unsupported: 0, duplicates: 0, other: 0
    };
    
    const warnings: { type: string; message: string; fileId?: string; fileName?: string }[] = [];
    const fileHashes = new Set<string>();

    console.log(`[DISCOVERY] Starting discovery traversal for ${items.length} top-level item(s). Manifest ID: ${manifestId}`);
    await onProgress('SCAN_STARTED', { message: 'Initializing Discovery Phase...', googleRequests: 0 });
    
    let manifestBuffer: any[] = [];
    const flusherLimit = pLimit(3);
    const flushPromises: Promise<void>[] = [];
    let lastEventTime = Date.now();

    const enqueueChunkFlush = (chunk: any[]) => {
      const p = flusherLimit(async () => {
        const flushStart = Date.now();
        await ManifestStorage.saveManifestChunk(chunk);
        console.log(`[DISCOVERY] Pipelined DB flush: ${chunk.length} items saved in ${Date.now() - flushStart}ms`);
      });
      flushPromises.push(p);
    };

    const pushItemAndCheckFlush = (item: any) => {
      manifestBuffer.push(item);
      if (manifestBuffer.length >= 1000) {
        const chunk = manifestBuffer;
        manifestBuffer = [];
        enqueueChunkFlush(chunk);
      }
    };
    
    const engine = new DriveTraversalEngine<{ parentId: string, depth: number }>(drive, {
      onFolderEnter: async (folder, context) => {
        totalFolders++;
        pushItemAndCheckFlush({
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
        
        const now = Date.now();
        const elapsedSec = Math.max(0.1, (now - startTime) / 1000);
        const foldersPerSec = Math.round((totalFolders / elapsedSec) * 10) / 10;
        const filesPerSec = Math.round((totalFiles / elapsedSec) * 10) / 10;
        const apiRequestsPerSec = Math.round((engine.apiRequests / elapsedSec) * 10) / 10;

        await onProgress('SCAN_FOLDER', { 
          folderName: folder.name, 
          depth: context.depth,
          totalFolders, 
          totalFiles, 
          totalBytes,
          googleRequests: engine.apiRequests,
          foldersPerSec,
          filesPerSec,
          apiRequestsPerSec
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

        pushItemAndCheckFlush({
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
        if (now - lastEventTime > 200) {
          lastEventTime = now;
          const elapsedSec = Math.max(0.1, (now - startTime) / 1000);
          const foldersPerSec = Math.round((totalFolders / elapsedSec) * 10) / 10;
          const filesPerSec = Math.round((totalFiles / elapsedSec) * 10) / 10;
          const apiRequestsPerSec = Math.round((engine.apiRequests / elapsedSec) * 10) / 10;

          await onProgress('SCAN_PROGRESS', {
             currentFile: file.name,
             totalFolders, 
             totalFiles, 
             totalBytes, 
             googleRequests: engine.apiRequests,
             foldersPerSec,
             filesPerSec,
             apiRequestsPerSec
          });
        }
      },
      onPageScanned: async (stats) => {
        const now = Date.now();
        if (now - lastEventTime > 250) {
          lastEventTime = now;
          const elapsedSec = Math.max(0.1, (now - startTime) / 1000);
          const foldersPerSec = Math.round((totalFolders / elapsedSec) * 10) / 10;
          const filesPerSec = Math.round((totalFiles / elapsedSec) * 10) / 10;
          const apiRequestsPerSec = Math.round((engine.apiRequests / elapsedSec) * 10) / 10;

          await onProgress('SCAN_PAGE', {
             folderName: stats.folderName,
             queueDepth: stats.queueDepth,
             activeWorkers: stats.activeWorkers,
             pagesScanned: engine.pagesScanned,
             totalFolders,
             totalFiles,
             totalBytes,
             googleRequests: engine.apiRequests,
             foldersPerSec,
             filesPerSec,
             apiRequestsPerSec
          });
        }
      }
    }, async (name: string, op: () => Promise<any>) => {
      return RetryHelper.withRetry(name, op, (msg) => console.log(`[DISCOVERY] ${msg}`));
    });

    for (const item of items) {
       console.log(`[DISCOVERY] Scanning root item ID: ${item.id}, isFolder: ${item.isFolder}`);
       await engine.traverseItem(item, { parentId: 'root', depth: 0 });
    }

    // Flush any remaining buffered manifest items
    if (manifestBuffer.length > 0) {
      enqueueChunkFlush(manifestBuffer);
      manifestBuffer = [];
    }

    console.log(`[DISCOVERY] Awaiting remaining pipelined DB flushes (${flushPromises.length} batches)...`);
    await onProgress('FINALIZING', { 
      message: `Finalizing discovery scan and saving ${flushPromises.length} manifest batches to database...`, 
      totalFolders, 
      totalFiles, 
      totalBytes, 
      googleRequests: engine.apiRequests 
    });

    const flushResults = await Promise.allSettled(flushPromises);
    const failedFlushes = flushResults.filter(r => r.status === 'rejected');
    if (failedFlushes.length > 0) {
      console.warn(`[DISCOVERY] ${failedFlushes.length}/${flushPromises.length} DB manifest chunk flushes rejected with errors. Continuing finalization.`);
    } else {
      console.log(`[DISCOVERY] All ${flushPromises.length} DB manifest chunk flushes completed successfully.`);
    }

    const totalElapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
    const finalFoldersPerSec = Math.round((totalFolders / totalElapsedSec) * 10) / 10;
    const finalFilesPerSec = Math.round((totalFiles / totalElapsedSec) * 10) / 10;
    const finalApiRequestsPerSec = Math.round((engine.apiRequests / totalElapsedSec) * 10) / 10;

    console.log(`\n==================================================`);
    console.log(`[DISCOVERY PROFILE SUMMARY]`);
    console.log(`- Total Time Elapsed: ${totalElapsedSec.toFixed(2)}s`);
    console.log(`- Google API Cumulative Latency: ${engine.apiTimeMs}ms`);
    console.log(`- Total Google API Requests: ${engine.apiRequests} (${finalApiRequestsPerSec} req/s)`);
    console.log(`- Discovered Folders: ${totalFolders} (${finalFoldersPerSec} folders/s)`);
    console.log(`- Discovered Files: ${totalFiles} (${finalFilesPerSec} files/s)`);
    console.log(`- Total Items: ${totalFolders + totalFiles} (${((totalFolders + totalFiles) / totalElapsedSec).toFixed(1)} items/s)`);
    console.log(`- Total Bytes: ${(totalBytes / 1e9).toFixed(3)} GB`);
    console.log(`==================================================\n`);

    await onProgress('MANIFEST_UPDATED', { message: 'Analyzing destination storage...', googleRequests: engine.apiRequests, totalFolders, totalFiles, totalBytes });
    
    // Analyze Storage Requirements
    const storageAnalysis = await StorageAnalyzer.analyzeStorage(userId, totalBytes);
    
    if (!storageAnalysis.sufficient) {
       warnings.push(...storageAnalysis.warnings.map(w => ({ type: 'STORAGE_EXHAUSTION', message: w })));
    }

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
       googleRequests: engine.apiRequests,
       elapsedSec: totalElapsedSec,
       foldersPerSec: finalFoldersPerSec,
       filesPerSec: finalFilesPerSec,
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
