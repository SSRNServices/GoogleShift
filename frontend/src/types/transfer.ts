import type { DriveFolder, DriveFile } from './drive';

export interface TransferOptionsState {
  preserveStructure: boolean;
  overwriteExisting: boolean;
  skipExisting: boolean;
  renameConflicts: boolean;
  verifyChecksums: boolean;
  keepOriginalDate: boolean;
  transferDocsAsPdf: boolean;
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
