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
}
