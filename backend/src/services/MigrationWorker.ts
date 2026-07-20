import { google, drive_v3 } from 'googleapis';
import { oauthService } from '../oauth/OAuthService';
import { updateJobProgress, logJobEvent } from '../utils/database';

export class MigrationWorker {
  private getClient(type: 'source' | 'destination'): drive_v3.Drive {
    const auth = oauthService.getAuthenticatedClient(type);
    if (!auth) throw new Error(`Account ${type} not authenticated`);
    return google.drive({ version: 'v3', auth });
  }

  public async executeMigration(job: any) {
    const sourceSelection = JSON.parse(job.sourceSelection);
    const destinationFolder = JSON.parse(job.destinationFolder);
    const options = JSON.parse(job.options || '{}');

    await logJobEvent(job.jobId, `Migration started with ${sourceSelection.length} items.`);

    const sourceDrive = this.getClient('source');
    const destDrive = this.getClient('destination');

    let totalFolders = job.totalFolders || 0;
    let totalFiles = job.totalFiles || 0;
    let totalBytes = job.totalBytes || 0;
    let completedFolders = job.completedFolders || 0;
    let completedFiles = job.completedFiles || 0;
    let failedFiles = job.failedFiles || 0;
    let transferredBytes = job.transferredBytes || 0;

    const emitProgress = async (currentFile = '', currentFolder = '') => {
      await updateJobProgress(job.jobId, {
        totalFolders, totalFiles, totalBytes,
        completedFolders, completedFiles, failedFiles, transferredBytes,
        currentFile, currentFolder
      });
    };

    // Helper: Delay
    const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

    // Helper: Retry with exponential backoff
    const withRetry = async <T>(operation: () => Promise<T>, retries = 3): Promise<T> => {
      for (let i = 0; i < retries; i++) {
        try {
          return await operation();
        } catch (error: any) {
          const status = error?.response?.status;
          if (status === 403 || status === 429 || status >= 500) {
            if (i === retries - 1) throw error;
            const backoff = Math.pow(2, i) * 1000 + Math.random() * 1000;
            await logJobEvent(job.jobId, `Retry ${i + 1}/${retries} after ${Math.round(backoff)}ms (Error: ${status})`);
            await delay(backoff);
          } else {
            throw error;
          }
        }
      }
      throw new Error('Unreachable');
    };

    const copyFile = async (sourceId: string, name: string, mimeType: string, destParentId: string, sizeStr?: string) => {
      const size = sizeStr ? parseInt(sizeStr, 10) : 0;
      await logJobEvent(job.jobId, `Uploading file ${name}`);
      await emitProgress(name, '');

      try {
        await withRetry(async () => {
          let mediaBody: any;
          let targetMimeType = mimeType;
          let exportMimeType: string | null = null;

          if (mimeType.startsWith('application/vnd.google-apps.')) {
            // It's a Google Workspace file
            if (mimeType === 'application/vnd.google-apps.document') {
              exportMimeType = options.transferDocsAsPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
              targetMimeType = options.transferDocsAsPdf ? 'application/pdf' : mimeType;
            } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
              exportMimeType = options.transferDocsAsPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
              targetMimeType = options.transferDocsAsPdf ? 'application/pdf' : mimeType;
            } else if (mimeType === 'application/vnd.google-apps.presentation') {
              exportMimeType = options.transferDocsAsPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
              targetMimeType = options.transferDocsAsPdf ? 'application/pdf' : mimeType;
            }

            if (exportMimeType) {
              const res = await sourceDrive.files.export({ fileId: sourceId, mimeType: exportMimeType }, { responseType: 'stream' });
              mediaBody = res.data;
            } else {
              // unsupported google apps file
              await logJobEvent(job.jobId, `Skipped unsupported file type: ${name}`);
              return;
            }
          } else {
            // Normal file download
            const res = await sourceDrive.files.get({ fileId: sourceId, alt: 'media' }, { responseType: 'stream' });
            mediaBody = res.data;
          }

          if (options.skipExisting) {
            // Check if file exists in destination
            const existingRes = await destDrive.files.list({
              q: `name = '${name.replace(/'/g, "\\'")}' and '${destParentId}' in parents and trashed = false`,
              fields: 'files(id)'
            });
            if (existingRes.data.files && existingRes.data.files.length > 0) {
              await logJobEvent(job.jobId, `Skipped existing file: ${name}`);
              return;
            }
          }

          // Upload
          const createRes = await destDrive.files.create({
            requestBody: {
              name,
              parents: [destParentId],
              mimeType: targetMimeType
            },
            media: {
              body: mediaBody
            },
            fields: 'id, md5Checksum'
          });

          await logJobEvent(job.jobId, `Finished uploading ${name}`);
        });

        completedFiles++;
        transferredBytes += size;
      } catch (e: any) {
        failedFiles++;
        await logJobEvent(job.jobId, `Failed to copy ${name}: ${e.message}`);
      }
      await emitProgress('', '');
    };

    const processFolder = async (sourceId: string, sourceName: string, destParentId: string) => {
      await emitProgress('', sourceName);
      
      // Create folder in dest
      let newDestFolderId = destParentId;
      if (options.preserveStructure) {
        await logJobEvent(job.jobId, `Created folder ${sourceName}`);
        
        let folderExists = false;
        if (options.skipExisting) {
          const existing = await destDrive.files.list({
            q: `name = '${sourceName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${destParentId}' in parents and trashed = false`,
            fields: 'files(id)'
          });
          if (existing.data.files && existing.data.files.length > 0) {
            newDestFolderId = existing.data.files[0].id!;
            folderExists = true;
          }
        }
        
        if (!folderExists) {
          const createRes = await withRetry(() => destDrive.files.create({
            requestBody: {
              name: sourceName,
              mimeType: 'application/vnd.google-apps.folder',
              parents: [destParentId]
            },
            fields: 'id'
          }));
          newDestFolderId = createRes.data.id!;
        }
      }
      completedFolders++;
      await emitProgress('', sourceName);

      // List children
      let pageToken: string | undefined = undefined;
      do {
        const res = await withRetry(() => sourceDrive.files.list({
          q: `'${sourceId}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType, size)',
          pageSize: 100,
          pageToken
        }));

        const children = res.data.files || [];
        for (const child of children) {
          if (!child.id || !child.name) continue;
          if (child.mimeType === 'application/vnd.google-apps.folder') {
            totalFolders++;
            await emitProgress('', child.name);
            await processFolder(child.id, child.name, newDestFolderId);
          } else {
            totalFiles++;
            const size = child.size ? parseInt(child.size, 10) : 0;
            totalBytes += size;
            await emitProgress(child.name, '');
            await copyFile(child.id, child.name, child.mimeType || '', newDestFolderId, child.size || '0');
          }
        }
        pageToken = res.data.nextPageToken || undefined;
      } while (pageToken);
    };

    // Begin processing
    try {
      const actualDestId = destinationFolder.id === 'root' ? 'root' : destinationFolder.id;
      for (const item of sourceSelection) {
        if (item.isFolder || item.mimeType === 'application/vnd.google-apps.folder') {
          totalFolders++;
          await emitProgress('', item.name);
          await processFolder(item.id === 'root' ? 'root' : item.id, item.name, actualDestId);
        } else {
          totalFiles++;
          const size = item.size ? parseInt(item.size, 10) : 0;
          totalBytes += size;
          await emitProgress(item.name, '');
          await copyFile(item.id, item.name, item.mimeType || '', actualDestId, item.size?.toString());
        }
      }
      
      await logJobEvent(job.jobId, `Migration completed successfully.`);
    } catch (e: any) {
      await logJobEvent(job.jobId, `Migration terminated with error: ${e.message}`);
      throw e;
    }
  }
}

export const migrationWorker = new MigrationWorker();
