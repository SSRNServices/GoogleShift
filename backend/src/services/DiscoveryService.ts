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
    const flusherLimit = pLimit(1); // Enforce sequential execution on single SQLite connection
    const flushPromises: Promise<void>[] = [];
    let flushError: Error | null = null;
    let lastEventTime = Date.now();

    const enqueueChunkFlush = (chunk: any[]) => {
      const p = flusherLimit(async () => {
        if (flushError) return;
        const flushStart = Date.now();
        await ManifestStorage.saveManifestChunk(chunk);
        console.log(`[DISCOVERY] Pipelined DB flush: ${chunk.length} items saved in ${Date.now() - flushStart}ms`);
      }).catch((err) => {
        if (!flushError) {
          flushError = err instanceof Error ? err : new Error(String(err));
          console.error(`[DISCOVERY FATAL] Manifest batch flush error: ${flushError.message}`);
        }
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
          if (warnings.length < 500) {
            warnings.push({ type: 'DUPLICATE_NAME', message: `Duplicate file detected: ${file.name}`, fileId: file.id, fileName: file.name });
          }
        } else {
          if (fileHashes.size < 100000) {
            fileHashes.add(hash);
          }
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

    // ── STRUCTURED FINALIZATION PIPELINE ──────────────────────────────────────────
    const finalizeStartMs = Date.now();
    console.log(`[DISCOVERY FINALIZE] 1. Entering finalization | jobId=${manifestId} userId=${userId} elapsedMs=${finalizeStartMs - startTime}`);

    console.log(`[DISCOVERY] Awaiting remaining pipelined DB flushes (${flushPromises.length} batches)...`);
    await onProgress('FINALIZING', { 
      message: `Finalizing discovery scan and saving ${flushPromises.length} manifest batches to database...`, 
      totalFolders, 
      totalFiles, 
      totalBytes, 
      googleRequests: engine.apiRequests 
    });

    await Promise.all(flushPromises);

    if (flushError) {
      const errorMsg = (flushError as Error).message;
      console.error(`[DISCOVERY FATAL] Manifest batch flushes failed: ${errorMsg}`);
      await onProgress('SCAN_FAILED', { error: `Manifest persistence failed: ${errorMsg}` });
      throw new Error(`Manifest persistence failed: ${errorMsg}`);
    }

    console.log(`[DISCOVERY FINALIZE] 2. All DB flushes awaited | flushPromises=${flushPromises.length} durationMs=${Date.now() - finalizeStartMs}`);

    // STEP 9: Derive and verify final counts from the persisted SQLite database
    console.log(`[DISCOVERY FINALIZE] 3. Manifest verification started | manifestId=${manifestId}`);
    const dbStats = await ManifestStorage.getSummaryStats(manifestId);
    const dbTotalCount = await ManifestStorage.countItems(manifestId);
    const expectedTotalCount = totalFolders + totalFiles;

    console.log(`[DISCOVERY FINALIZE] 4. Manifest verification completed | dbItems=${dbTotalCount} (Folders: ${dbStats.totalFolders}, Files: ${dbStats.totalFiles}, Bytes: ${dbStats.totalBytes}) expected=${expectedTotalCount}`);

    if (dbTotalCount !== expectedTotalCount) {
      const mismatchErr = `Persisted manifest count mismatch: SQLite database contains ${dbTotalCount} items, but traversal expected ${expectedTotalCount} items.`;
      console.error(`[DISCOVERY FATAL] ${mismatchErr}`);
      await onProgress('SCAN_FAILED', { error: mismatchErr });
      throw new Error(mismatchErr);
    }

    // Use verified database stats
    const finalFolders = dbStats.totalFolders;
    const finalFiles = dbStats.totalFiles;
    const finalBytes = dbStats.totalBytes;

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

    await onProgress('MANIFEST_UPDATED', { message: 'Analyzing destination storage & building summary...', googleRequests: engine.apiRequests, totalFolders, totalFiles, totalBytes });
    
    let storageAnalysis = {
      limit: 0,
      used: 0,
      remaining: 0,
      sufficient: true,
      warnings: [] as string[],
      estimatedTimeSeconds: Math.ceil(totalBytes / (25 * 1024 * 1024))
    };

    console.log(`[DISCOVERY FINALIZE] 5. StorageAnalyzer started | userId=${userId}`);
    try {
      const res = await StorageAnalyzer.analyzeStorage(userId, totalBytes);
      storageAnalysis = {
        limit: res.limit || 0,
        used: res.used || 0,
        remaining: res.remaining || 0,
        sufficient: res.sufficient,
        warnings: res.warnings || [],
        estimatedTimeSeconds: res.estimatedTimeSeconds || Math.ceil(totalBytes / (25 * 1024 * 1024))
      };
      if (!storageAnalysis.sufficient) {
        warnings.push(...storageAnalysis.warnings.map(w => ({ type: 'STORAGE_EXHAUSTION', message: w })));
      }
      console.log(`[DISCOVERY FINALIZE] 6. StorageAnalyzer completed | limit=${storageAnalysis.limit} used=${storageAnalysis.used} sufficient=${storageAnalysis.sufficient}`);
    } catch (storageErr: any) {
      console.warn(`[DISCOVERY FINALIZE] StorageAnalyzer error (non-fatal):`, storageErr.message);
    }

    const cappedWarnings = warnings.slice(0, 100);
    console.log(`[DISCOVERY FINALIZE] 7. ScanSummary persistence started | manifestId=${manifestId} totalWarnings=${warnings.length} cappedWarnings=${cappedWarnings.length}`);

    try {
      // 1. Upsert core ScanSummary record
      const summaryRecord = await prisma.scanSummary.upsert({
        where: { manifestId },
        create: {
          manifestId,
          totalFolders: finalFolders,
          totalFiles: finalFiles,
          totalBytes: finalBytes,
          destinationStorageLimit: storageAnalysis.limit,
          destinationStorageUsed: storageAnalysis.used,
          estimatedTimeSeconds: storageAnalysis.estimatedTimeSeconds,
          largestFile
        },
        update: {
          totalFolders: finalFolders,
          totalFiles: finalFiles,
          totalBytes: finalBytes,
          destinationStorageLimit: storageAnalysis.limit,
          destinationStorageUsed: storageAnalysis.used,
          estimatedTimeSeconds: storageAnalysis.estimatedTimeSeconds,
          largestFile
        }
      });

      // 2. Upsert MimeStats record
      await prisma.mimeStats.upsert({
        where: { summaryId: summaryRecord.id },
        create: { summaryId: summaryRecord.id, ...mimeStats },
        update: { ...mimeStats }
      }).catch(err => console.warn(`[DISCOVERY FINALIZE] MimeStats save warning:`, err.message));

      // 3. Recreate capped warnings (max 100 items to prevent parameter overflow)
      await prisma.scanWarning.deleteMany({ where: { summaryId: summaryRecord.id } }).catch(() => {});
      if (cappedWarnings.length > 0) {
        await prisma.scanWarning.createMany({
          data: cappedWarnings.map(w => ({
            summaryId: summaryRecord.id,
            type: w.type,
            message: w.message,
            fileId: w.fileId || null,
            fileName: w.fileName || null
          }))
        }).catch(err => console.warn(`[DISCOVERY FINALIZE] ScanWarning save warning:`, err.message));
      }

      console.log(`[DISCOVERY FINALIZE] 8. ScanSummary persistence completed | summaryId=${summaryRecord.id}`);
    } catch (summaryErr: any) {
      console.error(`[DISCOVERY FINALIZE ERROR] Error persisting ScanSummary to DB (non-fatal):`, summaryErr.message);
    }

    const finalSummary = {
       scanStatus: 'Completed' as const,
       manifestId,
       jobId: manifestId,
       totalFolders: finalFolders,
       totalFiles: finalFiles,
       totalBytes: finalBytes,
       googleRequests: engine.apiRequests,
       elapsedSec: totalElapsedSec,
       foldersPerSec: finalFoldersPerSec,
       filesPerSec: finalFilesPerSec,
       storageAnalysis,
       mimeStats,
       warnings: cappedWarnings,
       largestFile
    };

    console.log(`[DISCOVERY FINALIZE] 13. Emitting SCAN_COMPLETED | manifestId=${manifestId}`);
    await onProgress('SCAN_COMPLETED', finalSummary);
    console.log(`[DISCOVERY FINALIZE] 14. Finalization completed successfully | manifestId=${manifestId} totalElapsedSec=${totalElapsedSec.toFixed(2)}s`);
    return finalSummary;
  }
}
