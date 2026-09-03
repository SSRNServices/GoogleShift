import { defaultStorageProvider } from './LocalStorageProvider';

export class StorageInitializer {
  public static async initializeStorage(): Promise<void> {
    console.log('--- Storage Diagnostics Check ---');
    const created = await defaultStorageProvider.ensureDirectory();
    const diag = await defaultStorageProvider.getDiagnostics();

    console.log(`✓ Storage Provider: ${diag.provider}`);
    console.log(`✓ Storage Path: ${diag.path}`);
    console.log(`✓ Directory Exists: ${diag.exists}`);
    console.log(`✓ Writable: ${diag.writable}`);
    console.log(`✓ Readable: ${diag.readable}`);

    if (diag.userUid !== undefined) {
      console.log(`✓ Process User (UID/GID): ${diag.userUid}/${diag.userGid}`);
    }

    if (!diag.writable || !created) {
      console.error(`❌ [FATAL Storage Check Failed] Configured storage path '${diag.path}' is not writable!`);
      if (diag.error) {
        console.error(`   Error details: ${diag.error}`);
      }
      throw new Error(`Storage path '${diag.path}' is not writable. Application startup halted.`);
    }

    console.log('✓ Manifest Storage initialization completed cleanly.\n');

    console.log('--- Photos Temp Storage Diagnostics Check ---');
    const photosDiag = await defaultStorageProvider.getPhotosTempDiagnostics();
    console.log(`✓ Photos Temp Path: ${photosDiag.path}`);
    console.log(`✓ Exists: ${photosDiag.exists ? 'YES' : 'NO'}`);
    console.log(`✓ Writable: ${photosDiag.writable ? 'YES' : 'NO'}`);
    console.log(`✓ Readable: ${photosDiag.readable ? 'YES' : 'NO'}`);
    if (photosDiag.userUid !== undefined) {
      console.log(`✓ UID/GID: ${photosDiag.userUid}/${photosDiag.userGid}`);
    }
    if (photosDiag.freeSpaceFormatted) {
      console.log(`✓ Available Space: ${photosDiag.freeSpaceFormatted}`);
    }

    if (!photosDiag.writable) {
      console.error(`❌ [Photos Temp Storage Warning] Photos temp path '${photosDiag.path}' is not writable! Error: ${photosDiag.error || 'N/A'}`);
    } else {
      console.log('✓ Photos Temp Storage initialization completed cleanly.\n');
    }
  }
}
