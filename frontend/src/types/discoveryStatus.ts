export const DiscoveryStatus = {
  CREATED: 'CREATED',
  QUEUED: 'QUEUED',
  CONNECTING: 'CONNECTING',
  DISCOVERING: 'DISCOVERING',
  SCANNING: 'SCANNING',
  FINALIZING: 'FINALIZING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
} as const;

export type DiscoveryStatus = typeof DiscoveryStatus[keyof typeof DiscoveryStatus];

export interface DiscoveryResponse {
  jobId: string;
  status: DiscoveryStatus | string;
  phase: DiscoveryStatus | string;
  state: DiscoveryStatus | string;
  progress: number;
  completed: boolean;
  foldersFound: number;
  filesFound: number;
  bytesFound: number;
  folders?: number;
  files?: number;
  bytes?: number;
  totalFolders?: number;
  totalFiles?: number;
  totalBytes?: number;
  googleRequests?: number;
  manifestId?: string;
  currentFolder?: string | null;
  currentFile?: string | null;
  elapsed?: number;
  message?: string;
  error?: string;
  data?: any;
  event?: string;
}
