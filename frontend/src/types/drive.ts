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

export interface StorageStats {
  limit: number;
  used: number;
  remaining: number;
  sufficient: boolean;
  warnings: string[];
  estimatedTimeSeconds: number;
}

export interface MimeBreakdown {
  googleDocs: number;
  googleSheets: number;
  googleSlides: number;
  pdf: number;
  images: number;
  videos: number;
  archives: number;
  unsupported: number;
  duplicates: number;
  other: number;
}

export interface ScanWarningInfo {
  type: string;
  message: string;
  fileId?: string;
  fileName?: string;
}

export interface ScanSummaryResult {
  scanStatus: 'Idle' | 'Scanning' | 'Completed' | 'Failed' | 'Disconnected';
  manifestId?: string;
  jobId?: string;
  
  // High-level Stats
  totalFolders: number;
  totalFiles: number;
  totalBytes: number;
  largestFile: number;
  
  // Storage and Estimations
  storageAnalysis?: StorageStats;
  
  // Breakdown
  mimeStats?: MimeBreakdown;
  
  // Warnings
  warnings?: ScanWarningInfo[];
}
