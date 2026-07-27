export interface MigrationConfig {
  workerCount: number;
  folderWorkers: number;
  chunkSize: number;
  retryCount: number;
  progressInterval: number;
  keepAlive: boolean;
  adaptiveConcurrency: boolean;
  maxSockets: number;
  resumeInterval: number;
  
  // Performance tuning
  maxDownloadWorkers: number;
  maxUploadWorkers: number;
  smallFileWorkers: number;
  largeFileWorkers: number;
  streamBufferSize: number;
  uploadChunkSize: number;
  downloadChunkSize: number;
  http2: boolean;
  maxMemory: number;
}

export const DEFAULT_MIGRATION_CONFIG: MigrationConfig = {
  workerCount: 10,
  folderWorkers: 4,
  chunkSize: 16 * 1024 * 1024, // 16 MB
  retryCount: 5,
  progressInterval: 250, // ms
  keepAlive: true,
  adaptiveConcurrency: true,
  maxSockets: 100,
  resumeInterval: 5000, // 5 seconds
  
  maxDownloadWorkers: 50,
  maxUploadWorkers: 50,
  smallFileWorkers: 40,
  largeFileWorkers: 4,
  streamBufferSize: 16 * 1024 * 1024,
  uploadChunkSize: 16 * 1024 * 1024,
  downloadChunkSize: 16 * 1024 * 1024,
  http2: true,
  maxMemory: 1024 * 1024 * 1024 * 2 // 2GB
};

export interface ProgressMetrics {
  totalFolders: number;
  totalFiles: number;
  totalBytes: number;
  completedFolders: number;
  completedFiles: number;
  failedFiles: number;
  transferredBytes: number;
  currentFile: string;
  currentFolder: string;
  lastSuccessfulFile: string;
  
  // Dashboard additions
  currentWorkers: number;
  idleWorkers: number;
  busyWorkers: number;
  queueLength: number;
  currentSpeed: number; // bytes per sec
  averageSpeed: number; // bytes per sec
  eta: number; // seconds
  deadWorkers: number;
  retryCount: number;
  status: string;
  networkStatus: string;
}

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  createdTime?: string;
  owner?: string;
  icon?: string;
  thumbnail?: string;
  parentId?: string;
  childrenCount?: number;
  shortcutDetails?: {
    targetId?: string;
    targetMimeType?: string;
  };
}

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

export interface MigrationRequest {
  manifestId: string;
  sourceSelection: DriveItem[];
  destinationFolder: DriveItem;
  options: TransferOptionsState;
}

export interface MigrationJob extends MigrationRequest {
  jobId: string;
  status: string;
  totalFolders: number;
  totalFiles: number;
  totalBytes: number;
  failedFiles: number;
  lastSuccessfulFile: string;
  sessionId?: string;
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
