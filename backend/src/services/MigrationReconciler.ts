// @ts-nocheck
import { drive_v3 } from 'googleapis';
import { ManifestStorage, ManifestItem } from '../utils/ManifestStorage';

export interface ReconciliationReport {
  totalUnresolved: number;
  unresolvedFolders: number;
  unresolvedFiles: number;
  foldersRecovered: number;
  filesQueued: number;
  itemsResolved: number;
  details: string[];
}

export class MigrationReconciler {
  /**
   * Deterministic Reconciliation Engine.
   * Compares SQLite manifest state against parent-child dependencies and Google Drive destination state.
   * Resolves stuck folder/file nodes, links parent destination IDs, and re-queues recoverable work.
   */
  public static async reconcileSchedulerState(
    manifestId: string,
    destDrive?: drive_v3.Drive,
    rootDestId: string = 'root'
  ): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      totalUnresolved: 0,
      unresolvedFolders: 0,
      unresolvedFiles: 0,
      foldersRecovered: 0,
      filesQueued: 0,
      itemsResolved: 0,
      details: []
    };

    try {
      let pass = 0;
      const maxPasses = 5;

      while (pass < maxPasses) {
        pass++;
        let passRecovered = 0;

        const unresolvedItems = await ManifestStorage.getUnresolvedItems(manifestId, 5000);
        report.totalUnresolved = unresolvedItems.length;

        if (unresolvedItems.length === 0) {
          break;
        }

        const unresolvedFolders = unresolvedItems.filter(i => i.isFolder);
        const unresolvedFiles = unresolvedItems.filter(i => !i.isFolder);
        report.unresolvedFolders = unresolvedFolders.length;
        report.unresolvedFiles = unresolvedFiles.length;

        // ── Step A: Build in-memory map of completed folder destination IDs ──────
        const folderCache = await ManifestStorage.getFolderCache(manifestId);
        folderCache.set('root', rootDestId);
        folderCache.set('root_dest', rootDestId);

        // ── Step B: Reconcile parent destination IDs and unlock PENDING items ─────
        for (const item of unresolvedItems) {
          // 1. Resolve destParentId if missing
          if (!item.destParentId || item.destParentId === 'root') {
            const resolvedParentDestId = item.sourceParentId === 'root'
              ? rootDestId
              : folderCache.get(item.sourceParentId);

            if (resolvedParentDestId) {
              item.destParentId = resolvedParentDestId;
              await ManifestStorage.updateDestParentId(manifestId, item.sourceParentId, resolvedParentDestId);
              report.details.push(`Resolved destParentId=${resolvedParentDestId} for item ${item.name} (${item.id})`);
            }
          }

          // 2. Folder reconciliation
          if (item.isFolder) {
            const parentDestId = item.sourceParentId === 'root'
              ? rootDestId
              : folderCache.get(item.sourceParentId);

            // If parent is already created, unlock child folder to QUEUED
            if (parentDestId && item.status === 'PENDING') {
              await ManifestStorage.updateItemStatus(manifestId, item.id, 'QUEUED');
              item.status = 'QUEUED';
              report.foldersRecovered++;
              passRecovered++;
              report.details.push(`Unlocked folder ${item.name} (${item.id}) PENDING -> QUEUED`);
            }

            // Check if folder was already created on destination Google Drive
            if (destDrive && parentDestId && item.status !== 'SUCCESS') {
              try {
                const searchRes = await destDrive.files.list({
                  q: `name = '${item.name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${parentDestId}' in parents and trashed = false`,
                  fields: 'files(id)'
                }, { timeout: 15000 });

                if (searchRes.data.files && searchRes.data.files.length > 0 && searchRes.data.files[0].id) {
                  const existingFolderId = searchRes.data.files[0].id;
                  await ManifestStorage.updateCreatedDestId(manifestId, item.id, existingFolderId);
                  await ManifestStorage.updateItemStatus(manifestId, item.id, 'SUCCESS');
                  folderCache.set(item.id, existingFolderId);
                  folderCache.set(item.sourceId, existingFolderId);
                  await ManifestStorage.queueChildrenOf(manifestId, item.id);
                  await ManifestStorage.queueChildrenOf(manifestId, item.sourceId);
                  report.foldersRecovered++;
                  report.itemsResolved++;
                  passRecovered++;
                  report.details.push(`Reconciled existing Google Drive folder ${item.name} (${item.id}) -> destId=${existingFolderId}`);
                }
              } catch (driveErr: any) {
                console.warn(`[MigrationReconciler] Google Drive search warning for folder ${item.name}: ${driveErr.message}`);
              }
            }
          }

          // 3. File reconciliation
          if (!item.isFolder) {
            const parentDestId = item.sourceParentId === 'root'
              ? rootDestId
              : (item.destParentId || folderCache.get(item.sourceParentId));

            if (parentDestId && item.status === 'PENDING') {
              await ManifestStorage.updateItemStatus(manifestId, item.id, 'QUEUED');
              item.status = 'QUEUED';
              report.filesQueued++;
              passRecovered++;
              report.details.push(`Unlocked file ${item.name} (${item.id}) PENDING -> QUEUED`);
            }
          }
        }

        // ── Step C: Recover stuck UPLOADING/VERIFYING files back to QUEUED ─────────
        const stuckFiles = unresolvedFiles.filter(
          f => f.status === 'UPLOADING' || f.status === 'VERIFYING'
        );
        if (stuckFiles.length > 0) {
          const recoveredCount = await ManifestStorage.updateManyStatus(
            manifestId,
            { isFolder: false, statusIn: ['UPLOADING', 'VERIFYING'] },
            'QUEUED'
          );
          if (recoveredCount.count > 0) {
            report.filesQueued += recoveredCount.count;
            passRecovered += recoveredCount.count;
            report.details.push(`Recovered ${recoveredCount.count} stuck UPLOADING/VERIFYING files back to QUEUED`);
          }
        }

        // If no progress made in this pass, exit loop
        if (passRecovered === 0) {
          break;
        }
      }

      console.log(
        `[MigrationReconciler] RECONCILIATION_COMPLETE | Manifest: ${manifestId} | ` +
        `Unresolved: ${report.totalUnresolved} | FoldersRecovered: ${report.foldersRecovered} | ` +
        `FilesQueued: ${report.filesQueued} | ItemsResolved: ${report.itemsResolved}`
      );

      return report;
    } catch (err: any) {
      console.error(`[MigrationReconciler] Error during reconciliation for manifest ${manifestId}: ${err.message}`);
      return report;
    }
  }
}
