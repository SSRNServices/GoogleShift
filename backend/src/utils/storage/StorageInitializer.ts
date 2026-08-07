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

    console.log('✓ Storage initialization completed cleanly.\n');
  }
}
