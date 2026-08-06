export const DiscoveryStatus = {
  CREATED: 'CREATED',
  QUEUED: 'QUEUED',
  DISCOVERING: 'DISCOVERING',
  SCANNING: 'SCANNING',
  FINALIZING: 'FINALIZING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
} as const;

export type DiscoveryStatus = typeof DiscoveryStatus[keyof typeof DiscoveryStatus];

export interface StandardDiscoveryResponse {
  jobId: string;
  status: DiscoveryStatus;
  phase: DiscoveryStatus;
  state: DiscoveryStatus;
  progress: number;
  completed: boolean;
  foldersFound: number;
  filesFound: number;
  bytesFound: number | string;
  manifestId?: string;
  currentFolder?: string | null;
  currentFile?: string | null;
  elapsed?: number;
  message?: string;
}
