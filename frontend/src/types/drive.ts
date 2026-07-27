export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  icon?: string;
  thumbnail?: string;
  parentId?: string;
}

export type DriveFolder = DriveItem;
export type DriveFile = DriveItem;

export type SelectionMode = 'ENTIRE_DRIVE' | 'FOLDER' | 'FILES';

export interface FolderSelection {
  folder: DriveFolder;
}

export interface FileSelection {
  files: DriveFile[];
}

export interface ScanSummaryResult {
  selectedItems: number;
  folderCount: number;
  fileCount: number;
  totalBytes: number;
  googleDocs: number;
  googleSheets: number;
  googleSlides: number;
  unsupported: number;
  duplicates: number;
  largestFile: number;
  scanStatus: 'Idle' | 'Scanning' | 'Completed' | 'Failed' | 'Disconnected';
  manifestId?: string;
  jobId?: string;
}
