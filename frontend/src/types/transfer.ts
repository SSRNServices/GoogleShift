import type { DriveFolder, DriveFile, DriveItem } from './drive';

export interface TransferOptionsState {
  preserveStructure: boolean;
  overwriteExisting: boolean;
  skipExisting: boolean;
  renameConflicts: boolean;
  verifyChecksums: boolean;
  keepOriginalDate: boolean;
  transferDocsAsPdf: boolean;
  preservePermissions: boolean;
  threads: number;
  chunkSize: number;
  skipErrors: boolean;
  dryRun: boolean;
}

export type TransferMode = 'ENTIRE_DRIVE' | 'FOLDER' | 'FILES';

export interface FolderSelection {
  folder: DriveFolder;
}

export interface FileSelection {
  files: DriveFile[];
}

export interface TransferManifest {
  sourceSelection: (DriveFolder | DriveFile)[];
  destinationFolder: DriveFolder | null;
  options: TransferOptionsState;
}

export type ConflictStrategy = 'OVERWRITE' | 'SKIP' | 'RENAME';

export interface StartMigrationPayload {
  manifestId?: string;
  sourceSelection: DriveItem[];
  destinationFolderId: string;
  options: TransferOptionsState;
}
