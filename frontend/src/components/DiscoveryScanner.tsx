import { useEffect, useState, useRef, useCallback } from 'react';
import { API_URL } from '../config/api';
import { migrationApi } from '../api/migrationApi';
import { useAuthStore } from '../store/useAuthStore';
import { Loader2, FolderOpen, File as FileIcon, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';

interface SummaryResult {
  totalFolders?: number;
  totalFiles?: number;
  totalBytes?: number;
  manifestId?: string;
  warnings?: string[];
  [key: string]: unknown;
}

interface DiscoveryScannerProps {
  sourceId: string;
  sessionId: string;
  onComplete: (summary: SummaryResult) => void;
  onError: (error: string) => void;
}

const formatBytes = (bytes: number) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export interface DiscoveryStats {
  status: string;
  folders: number;
  files: number;
  bytes: number;
  googleRequests: number;
  foldersPerSec: number;
  filesPerSec: number;
  queueDepth: number;
  activeWorkers: number;
  message: string;
  elapsed: number;
}

export function DiscoveryScanner({ sourceId, sessionId, onComplete, onError }: DiscoveryScannerProps) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [stats, setStats] = useState<DiscoveryStats>({
    status: 'QUEUED',
    folders: 0,
    files: 0,
    bytes: 0,
    googleRequests: 0,
    foldersPerSec: 0,
    filesPerSec: 0,
    queueDepth: 0,
    activeWorkers: 0,
    message: 'Initializing background discovery job...',
    elapsed: 0
  });

  const [completed, setCompleted] = useState(false);
  const [finalSummary, setFinalSummary] = useState<SummaryResult | null>(null);
  
  const abortControllerRef = useRef<AbortController | null>(null);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onCompleteRef.current = onComplete;
    onErrorRef.current = onError;
  }, [onComplete, onError]);

  const processIncomingData = useCallback((data: Record<string, unknown>): boolean => {
    if (!data) return false;

    console.log('[DiscoveryScanner] Ingestion Payload:', data);

    const rawStatus = String(data.status || data.phase || data.state || 'QUEUED').toUpperCase();
    console.log('[DiscoveryScanner] Current Normalized Status:', rawStatus);

    if (rawStatus === 'FAILED' || data.error) {
      const errMsg = String(data.error || data.message || 'Discovery job failed during execution.');
      console.error('[DiscoveryScanner] Failure/Error state received:', errMsg);
      setInitError(errMsg);
      onErrorRef.current(errMsg);
      return true;
    }

    if (rawStatus === 'CANCELLED') {
      const errMsg = 'Discovery job was cancelled.';
      setInitError(errMsg);
      onErrorRef.current(errMsg);
      return true;
    }

    const isCompletedState = rawStatus === 'COMPLETED' || data.completed === true || data.event === 'SCAN_COMPLETED';

    const newFolders = Number(data.foldersFound ?? data.totalFolders ?? data.folders ?? 0);
    const newFiles = Number(data.filesFound ?? data.totalFiles ?? data.files ?? 0);
    const newBytes = Number(data.bytesFound ?? data.totalBytes ?? data.bytes ?? 0);
    const elapsedMs = Number(data.elapsed || 0);

    if (isCompletedState) {
      const summaryObj: SummaryResult = (data.data as SummaryResult) || {
        totalFolders: newFolders,
        totalFiles: newFiles,
        totalBytes: newBytes,
        manifestId: String(data.manifestId || '')
      };

      console.log('[DiscoveryScanner] Discovery COMPLETED event received!', summaryObj);
      setCompleted(true);
      setFinalSummary(summaryObj);
      setStats(prev => ({
        status: 'COMPLETED',
        folders: Math.max(prev.folders, summaryObj.totalFolders || 0),
        files: Math.max(prev.files, summaryObj.totalFiles || 0),
        bytes: Math.max(prev.bytes, summaryObj.totalBytes || 0),
        googleRequests: Number(data.googleRequests) || Math.max(prev.googleRequests, newFolders || 1),
        foldersPerSec: 0,
        filesPerSec: 0,
        queueDepth: 0,
        activeWorkers: 0,
        elapsed: elapsedMs || prev.elapsed,
        message: 'Discovery complete!'
      }));
      onCompleteRef.current(summaryObj);
      return true;
    }

    setStats(prev => {
      const updatedFolders = Math.max(prev.folders, newFolders);
      const updatedFiles = Math.max(prev.files, newFiles);
      const updatedBytes = Math.max(prev.bytes, newBytes);
      const updatedGoogle = Number(data.googleRequests) || Math.max(prev.googleRequests, updatedFolders ? updatedFolders + 1 : 1);

      let messageStr = 'Scanning Google Drive...';
      if (rawStatus === 'FINALIZING') {
        messageStr = typeof data.currentFolder === 'string' && data.currentFolder ? data.currentFolder : 'Finalizing discovery & saving manifest to database...';
      } else if (data.currentFolder) {
        messageStr = `Scanning folder: ${data.currentFolder}`;
      } else if (data.currentFile) {
        messageStr = `Scanning file: ${data.currentFile}`;
      }

      return {
        status: rawStatus,
        folders: updatedFolders,
        files: updatedFiles,
        bytes: updatedBytes,
        googleRequests: updatedGoogle,
        foldersPerSec: Number(data.foldersPerSec) || prev.foldersPerSec,
        filesPerSec: Number(data.filesPerSec) || prev.filesPerSec,
        queueDepth: Number(data.queueDepth) || prev.queueDepth,
        activeWorkers: Number(data.activeWorkers) || prev.activeWorkers,
        elapsed: elapsedMs > 0 ? Math.max(prev.elapsed, elapsedMs) : prev.elapsed,
        message: messageStr
      };
    });

    return false;
  }, []);

  const startDiscoveryProcess = useCallback(async () => {
    setInitError(null);

    try {
      console.log(`[DiscoveryScanner] Requesting start for sourceId=${sourceId}, sessionId=${sessionId}`);
      const job = await migrationApi.startDiscovery(sourceId, sessionId);
      console.log('[DiscoveryScanner] Start Discovery API Response:', job);

      const activeJobId = job.jobId || job.id;
      const initialDone = processIncomingData(job as Record<string, unknown>);

      if (!initialDone && activeJobId) {
        setJobId(activeJobId);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Failed to initialize discovery';
      console.error(`[DiscoveryScanner] startDiscovery failed:`, errMsg);
      setInitError(errMsg);
      onErrorRef.current(errMsg);
    }
  }, [sourceId, sessionId, processIncomingData]);

  useEffect(() => {
    const timer = setTimeout(() => {
      startDiscoveryProcess();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [startDiscoveryProcess]);

  useEffect(() => {
    if (!jobId || completed) return;

    let isSubscribed = true;

    // Polling Channel (Guaranteed 1-second fallback)
    const pollStatus = async () => {
      if (!isSubscribed) return;
      try {
        const details = await migrationApi.getDiscoveryStatus(jobId);
        if (isSubscribed && details) {
          const isDone = processIncomingData(details as Record<string, unknown>);
          if (isDone) {
            isSubscribed = false;
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.warn('[DiscoveryScanner] Polling check warning:', err.message);
        }
      }
    };

    const pollIntervalId = window.setInterval(pollStatus, 1000);
    pollStatus(); // Initial immediate check

    // Streaming SSE Channel
    const streamDiscovery = async () => {
      try {
        const { accessToken } = useAuthStore.getState();
        const headers: Record<string, string> = {
          'Accept': 'text/event-stream'
        };
        if (accessToken) {
          headers['Authorization'] = `Bearer ${accessToken}`;
        }

        abortControllerRef.current = new AbortController();
        const response = await fetch(`${API_URL}/api/discovery/${jobId}/status?stream=true`, {
          headers,
          credentials: 'include',
          signal: abortControllerRef.current.signal
        });

        if (!response.ok || !response.body) {
           return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (isSubscribed) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            let dataStr = part.trim();
            if (dataStr.startsWith('data: ')) {
              dataStr = dataStr.substring(6).trim();
            }
            if (!dataStr || dataStr === ':') continue;

            try {
              const data = JSON.parse(dataStr);
              const isDone = processIncomingData(data as Record<string, unknown>);
              if (isDone) {
                isSubscribed = false;
                clearInterval(pollIntervalId);
                break;
              }
            } catch {
              // Ignore non-JSON ping lines
            }
          }
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.name !== 'AbortError') {
          console.warn('[DiscoveryScanner] Stream closed, continuing via polling channel:', error.message);
        }
      }
    };

    streamDiscovery();

    return () => {
      isSubscribed = false;
      clearInterval(pollIntervalId);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [jobId, completed, processIncomingData]);

  // Live Stopwatch Ticker
  useEffect(() => {
    if (!jobId || completed || initError) return;
    const timer = window.setInterval(() => {
      setStats(prev => ({
        ...prev,
        elapsed: prev.elapsed + 1000
      }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [jobId, completed, initError]);

  if (initError) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 p-6 rounded-lg border border-red-200 dark:border-red-800 text-center shadow-sm">
        <AlertTriangle className="w-10 h-10 text-red-500 mx-auto mb-3 animate-bounce" />
        <h3 className="text-lg font-semibold text-red-800 dark:text-red-300 mb-2">Discovery Phase Error</h3>
        <p className="text-sm text-red-600 dark:text-red-400 mb-4">{initError}</p>
        <button
          onClick={() => {
            startDiscoveryProcess();
          }}
          className="inline-flex items-center px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium text-sm rounded-md transition-colors shadow"
        >
          <RefreshCw className="w-4 h-4 mr-2" /> Retry Discovery
        </button>
      </div>
    );
  }

  if (completed && finalSummary) {
    return (
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 pb-4 mb-6">
           <div className="flex items-center space-x-3 text-green-600">
             <CheckCircle className="w-8 h-8" />
             <div>
               <h3 className="text-xl font-bold">Discovery Complete</h3>
               <p className="text-xs text-gray-500">Ready to proceed with migration</p>
             </div>
           </div>
           <span className="px-3 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-xs font-semibold rounded-full border border-green-200 dark:border-green-800">
             READY_FOR_MIGRATION
           </span>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
           <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded text-center border border-gray-100 dark:border-gray-700">
              <FolderOpen className="w-6 h-6 mx-auto mb-2 text-indigo-500" />
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{(finalSummary.totalFolders || stats.folders || 0).toLocaleString()}</div>
              <div className="text-sm text-gray-500">Folders</div>
           </div>
           <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded text-center border border-gray-100 dark:border-gray-700">
              <FileIcon className="w-6 h-6 mx-auto mb-2 text-blue-500" />
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{(finalSummary.totalFiles || stats.files || 0).toLocaleString()}</div>
              <div className="text-sm text-gray-500">Files</div>
           </div>
           <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded text-center border border-gray-100 dark:border-gray-700">
              <span className="block text-2xl mb-2">💾</span>
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{formatBytes(finalSummary.totalBytes || stats.bytes || 0)}</div>
              <div className="text-sm text-gray-500">Total Size</div>
           </div>
           <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded text-center border border-gray-100 dark:border-gray-700">
              <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-yellow-500" />
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{finalSummary.warnings?.length || 0}</div>
              <div className="text-sm text-gray-500">Warnings</div>
           </div>
        </div>
      </div>
    );
  }

  const getStatusBadge = (status: string) => {
    const s = (status || 'QUEUED').toUpperCase();
    switch (s) {
      case 'DISCOVERING':
      case 'SCANNING':
        return <span className="px-3 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs font-semibold rounded-full animate-pulse border border-blue-200 dark:border-blue-800">SCANNING</span>;
      case 'FINALIZING':
        return <span className="px-3 py-1 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-xs font-semibold rounded-full animate-pulse border border-purple-200 dark:border-purple-800">FINALIZING</span>;
      case 'PREPARING':
      case 'CONNECTING':
        return <span className="px-3 py-1 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 text-xs font-semibold rounded-full border border-yellow-200 dark:border-yellow-800">CONNECTING</span>;
      case 'COMPLETED':
        return <span className="px-3 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-xs font-semibold rounded-full border border-green-200 dark:border-green-800">COMPLETED</span>;
      default:
        return <span className="px-3 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs font-semibold rounded-full">QUEUED</span>;
    }
  };

  const formattedElapsed = `${Math.floor(stats.elapsed / 60000).toString().padStart(2, '0')}:${Math.floor((stats.elapsed % 60000) / 1000).toString().padStart(2, '0')}`;

  return (
    <div className="bg-gray-50 dark:bg-gray-800 p-8 rounded-lg border border-indigo-100 dark:border-indigo-900/30 text-center relative overflow-hidden shadow-sm">
      <div className="absolute top-0 left-0 right-0 h-1.5 bg-indigo-100 overflow-hidden">
         <div className="h-full bg-indigo-600 w-full animate-pulse" />
      </div>

      <div className="flex justify-between items-center mb-4">
        <div className="text-left">
           <h3 className="text-xl font-bold text-gray-900 dark:text-white">Discovering Drive Contents</h3>
           <p className="text-xs text-gray-500 dark:text-gray-400 font-mono mt-0.5">{stats.message}</p>
        </div>
        {getStatusBadge(stats.status)}
      </div>

      <div className="my-6">
        <Loader2 className="w-10 h-10 text-indigo-600 mx-auto mb-2 animate-spin" />
      </div>
      
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-6">
        <div className="bg-white dark:bg-gray-900 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.folders.toLocaleString()}</div>
          <div className="text-xs text-indigo-500 font-medium mt-0.5">+{stats.foldersPerSec}/s</div>
          <div className="text-xs text-gray-500 mt-1">Folders Found</div>
        </div>
        <div className="bg-white dark:bg-gray-900 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.files.toLocaleString()}</div>
          <div className="text-xs text-blue-500 font-medium mt-0.5">+{stats.filesPerSec}/s</div>
          <div className="text-xs text-gray-500 mt-1">Files Found</div>
        </div>
        <div className="bg-white dark:bg-gray-900 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{formatBytes(stats.bytes)}</div>
          <div className="text-xs text-gray-400 font-medium mt-0.5">Total Payload</div>
          <div className="text-xs text-gray-500 mt-1">Total Size</div>
        </div>
        <div className="bg-white dark:bg-gray-900 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{stats.googleRequests.toLocaleString()}</div>
          <div className="text-xs text-indigo-500 font-medium mt-0.5">Google API</div>
          <div className="text-xs text-gray-500 mt-1">API Requests</div>
        </div>
        <div className="bg-white dark:bg-gray-900 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{formattedElapsed}</div>
          <div className="text-xs text-gray-400 font-medium mt-0.5">Live Stopwatch</div>
          <div className="text-xs text-gray-500 mt-1">Elapsed Time</div>
        </div>
      </div>
    </div>
  );
}
