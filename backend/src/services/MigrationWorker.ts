import { google, drive_v3 } from 'googleapis';
import { oauthService } from '../oauth/OAuthService';
import { updateJobProgress, logJobEvent, saveCheckpoint, getCheckpoint } from '../utils/database';
import { NetworkHeartbeat } from '../utils/NetworkHeartbeat';

export class MigrationWorker {
  private async getClient(type: 'source' | 'destination', jobId: string): Promise<drive_v3.Drive> {
    return await this.withRetry(jobId, 'OAuth Refresh', async () => {
      const auth = oauthService.getAuthenticatedClient(type);
      if (!auth) throw new Error(`Account ${type} not authenticated`);
      // Force token refresh check implicitly or we can just return the client
      // The googleapis client automatically refreshes tokens on request, so we just return it.
      return google.drive({ version: 'v3', auth });
    });
  }

  private isTransientError(e: any): boolean {
    const code = e?.code || e?.cause?.code;
    const status = e?.response?.status || e?.status;

    // Node network errors
    const transientCodes = ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'];
    if (code && transientCodes.includes(code)) return true;
    if (e.message && e.message.includes('socket hang up')) return true;
    if (e.message && e.message.includes('TLS')) return true;

    // Google API transient errors
    if (status === 429) return true; // Rate limit
    if (status >= 500) return true; // 500, 502, 503, 504

    return false;
  }

  private isPermanentError(e: any): boolean {
    const status = e?.response?.status || e?.status;
    if (status === 401 || status === 403 || status === 404) return true;
    if (e.message && e.message.includes('invalid credentials')) return true;
    return false;
  }

  private async withRetry<T>(jobId: string, operationName: string, operation: () => Promise<T>): Promise<T> {
    const backoffs = [2, 4, 8, 16, 30, 60, 120, 300]; // in seconds
    const maxRetries = 10;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (e: any) {
        if (this.isPermanentError(e)) {
          throw e; // Do not retry permanent errors
        }
        
        if (this.isTransientError(e)) {
          if (attempt === maxRetries - 1) throw e;
          
          const delaySecs = backoffs[Math.min(attempt, backoffs.length - 1)] || 300;
          const jitter = Math.random() * 1000;
          const delayMs = delaySecs * 1000 + jitter;

          await updateJobProgress(jobId, { status: 'paused_network', networkStatus: 'offline', retryCount: attempt + 1 });
          await logJobEvent(jobId, `[${operationName}] Network error (${e.code || e.status}). Retrying (${attempt + 1}/${maxRetries}) in ${delaySecs}s...`);
          
          await new Promise(res => setTimeout(res, delayMs));
          
          // Before next attempt, ensure heartbeat is alive
          await NetworkHeartbeat.waitForOnline(async (online) => {
             if (!online) {
               await updateJobProgress(jobId, { status: 'paused_network', networkStatus: 'offline' });
               await logJobEvent(jobId, `Waiting for internet connection...`);
             }
          }, 5000);

          await updateJobProgress(jobId, { status: 'running', networkStatus: 'online' });
          await logJobEvent(jobId, `Resuming ${operationName}...`);
        } else {
          throw e; // Unknown error, bubble up
        }
      }
    }
    throw new Error('Unreachable');
  }

  public async executeMigration(job: any) {
    const sourceSelection = JSON.parse(job.sourceSelection);
    const destinationFolder = JSON.parse(job.destinationFolder);
    const options = JSON.parse(job.options || '{}');

    await logJobEvent(job.jobId, `Migration started with ${sourceSelection.length} items.`);
    await updateJobProgress(job.jobId, { status: 'running', networkStatus: 'online', retryCount: 0 });

    let totalFolders = job.totalFolders || 0;
    let totalFiles = job.totalFiles || 0;
    let totalBytes = job.totalBytes || 0;
    let completedFolders = job.completedFolders || 0;
    let completedFiles = job.completedFiles || 0;
    let failedFiles = job.failedFiles || 0;
    let transferredBytes = job.transferredBytes || 0;
    let lastSuccessfulFile = job.lastSuccessfulFile || '';

    const emitProgress = async (currentFile = '', currentFolder = '') => {
      await updateJobProgress(job.jobId, {
        totalFolders, totalFiles, totalBytes,
        completedFolders, completedFiles, failedFiles, transferredBytes,
        currentFile, currentFolder, lastSuccessfulFile
      });
    };

    const copyFile = async (sourceDrive: drive_v3.Drive, destDrive: drive_v3.Drive, sourceId: string, name: string, mimeType: string, destParentId: string, sizeStr?: string) => {
      // Checkpoint check
      const cp = await getCheckpoint(job.jobId, 'file', destParentId, sourceId);
      if (cp === 'completed' || cp === 'skipped') {
         await logJobEvent(job.jobId, `Resumed past completed file: ${name}`);
         return;
      }

      const size = sizeStr ? parseInt(sizeStr, 10) : 0;
      await logJobEvent(job.jobId, `Uploading file ${name}`);
      await emitProgress(name, '');

      try {
        await this.withRetry(job.jobId, `Upload ${name}`, async () => {
          let mediaBody: any;
          let targetMimeType = mimeType;
          let exportMimeType: string | null = null;

          if (mimeType.startsWith('application/vnd.google-apps.')) {
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
              await logJobEvent(job.jobId, `Skipped unsupported file type: ${name}`);
              await saveCheckpoint(job.jobId, 'file', destParentId, sourceId, 'skipped');
              return;
            }
          } else {
            const res = await sourceDrive.files.get({ fileId: sourceId, alt: 'media' }, { responseType: 'stream' });
            mediaBody = res.data;
          }

          if (options.skipExisting) {
            const existingRes = await destDrive.files.list({
              q: `name = '${name.replace(/'/g, "\\'")}' and '${destParentId}' in parents and trashed = false`,
              fields: 'files(id)'
            });
            if (existingRes.data.files && existingRes.data.files.length > 0) {
              await logJobEvent(job.jobId, `Skipped existing file: ${name}`);
              await saveCheckpoint(job.jobId, 'file', destParentId, sourceId, 'skipped');
              return;
            }
          }

          await destDrive.files.create({
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
          await saveCheckpoint(job.jobId, 'file', destParentId, sourceId, 'completed');
        });

        completedFiles++;
        transferredBytes += size;
        lastSuccessfulFile = name;
      } catch (e: any) {
        if (this.isPermanentError(e)) {
           failedFiles++;
           await logJobEvent(job.jobId, `Permanent failure copying ${name}: ${e.message}`);
           await saveCheckpoint(job.jobId, 'file', destParentId, sourceId, 'failed');
        } else {
           throw e; // Bubble up unexpected errors to terminate
        }
      }
      await emitProgress('', '');
    };

    const processFolder = async (sourceDrive: drive_v3.Drive, destDrive: drive_v3.Drive, sourceId: string, sourceName: string, destParentId: string) => {
      await emitProgress('', sourceName);
      
      let newDestFolderId = destParentId;
      if (options.preserveStructure) {
        // Check folder checkpoint
        const cp = await getCheckpoint(job.jobId, 'folder', destParentId, sourceId);
        if (cp && cp !== 'pending') {
           newDestFolderId = cp; // The ID of the created folder was saved
           await logJobEvent(job.jobId, `Resumed into existing folder: ${sourceName}`);
        } else {
           await logJobEvent(job.jobId, `Creating folder ${sourceName}`);
           let folderExists = false;
           if (options.skipExisting) {
             const existing = await this.withRetry(job.jobId, 'List Folders', () => destDrive.files.list({
               q: `name = '${sourceName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${destParentId}' in parents and trashed = false`,
               fields: 'files(id)'
             }));
             if (existing.data.files && existing.data.files.length > 0 && existing.data.files[0].id) {
               newDestFolderId = existing.data.files[0].id;
               folderExists = true;
             }
           }
           
           if (!folderExists) {
             const createRes = await this.withRetry(job.jobId, 'Create Folder', () => destDrive.files.create({
               requestBody: {
                 name: sourceName,
                 mimeType: 'application/vnd.google-apps.folder',
                 parents: [destParentId]
               },
               fields: 'id'
             }));
             newDestFolderId = createRes.data.id!;
           }
           await saveCheckpoint(job.jobId, 'folder', destParentId, sourceId, newDestFolderId);
           completedFolders++;
        }
      }
      await emitProgress('', sourceName);

      let pageToken: string | undefined = undefined;
      do {
        const listParams: any = {
          q: `'${sourceId}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType, size)',
          pageSize: 100
        };
        if (pageToken) listParams.pageToken = pageToken;
        
        const res: any = await this.withRetry(job.jobId, 'List Children', () => sourceDrive.files.list(listParams));

        const children = res.data.files || [];
        for (const child of children) {
          if (!child.id || !child.name) continue;
          if (child.mimeType === 'application/vnd.google-apps.folder') {
            totalFolders++;
            await emitProgress('', child.name);
            await processFolder(sourceDrive, destDrive, child.id, child.name, newDestFolderId);
          } else {
            totalFiles++;
            const size = child.size ? parseInt(child.size, 10) : 0;
            totalBytes += size;
            await emitProgress(child.name, '');
            await copyFile(sourceDrive, destDrive, child.id, child.name, child.mimeType || '', newDestFolderId, child.size || '0');
          }
        }
        pageToken = res.data.nextPageToken || undefined;
      } while (pageToken);
    };

    try {
      const sourceDrive = await this.getClient('source', job.jobId);
      const destDrive = await this.getClient('destination', job.jobId);

      const actualDestId = destinationFolder.id === 'root' ? 'root' : destinationFolder.id;
      for (const item of sourceSelection) {
        if (item.isFolder || item.mimeType === 'application/vnd.google-apps.folder') {
          totalFolders++;
          await emitProgress('', item.name);
          await processFolder(sourceDrive, destDrive, item.id === 'root' ? 'root' : item.id, item.name, actualDestId);
        } else {
          totalFiles++;
          const size = item.size ? parseInt(item.size, 10) : 0;
          totalBytes += size;
          await emitProgress(item.name, '');
          await copyFile(sourceDrive, destDrive, item.id, item.name, item.mimeType || '', actualDestId, item.size?.toString());
        }
      }
      
      const finalStatus = failedFiles > 0 ? 'completed_with_errors' : 'completed';
      await logJobEvent(job.jobId, `Migration ${finalStatus}.`);
      await updateJobProgress(job.jobId, { status: finalStatus, networkStatus: 'online' });
    } catch (e: any) {
      await logJobEvent(job.jobId, `Migration terminated with error: ${e.message}`);
      await updateJobProgress(job.jobId, { status: 'failed', networkStatus: 'online' });
      throw e;
    }
  }
}

export const migrationWorker = new MigrationWorker();
