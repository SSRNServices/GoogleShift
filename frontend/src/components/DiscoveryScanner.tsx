import { useEffect, useState, useRef } from 'react';
import { API_URL } from '../config/api';
import { migrationApi } from '../api/migrationApi';
import { useAuthStore } from '../store/useAuthStore';
import { Loader2, FolderOpen, File as FileIcon, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';

interface DiscoveryScannerProps {
  sourceId: string;
  sessionId: string;
  onComplete: (summary: any) => void;
  onError: (error: string) => void;
}

const formatBytes = (bytes: number) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export function DiscoveryScanner({ sourceId, sessionId, onComplete, onError }: DiscoveryScannerProps) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [stats, setStats] = useState({
    status: 'QUEUED',
    folders: 0,
    files: 0,
    bytes: 0,
    googleRequests: 0,
    foldersPerSec: 0,
    filesPerSec: 0,
    message: 'Initializing background discovery job...',
    elapsed: 0
  });

  const [completed, setCompleted] = useState(false);
  const [finalSummary, setFinalSummary] = useState<any>(null);
  
  const abortControllerRef = useRef<AbortController | null>(null);
  const hasStartedRef = useRef(false);
  const lastProgressTimeRef = useRef<number>(Date.now());

  const startDiscoveryProcess = async () => {
    setInitError(null);
    setCompleted(false);
    setFinalSummary(null);
    setStats({
      status: 'QUEUED',
      folders: 0,
      files: 0,
      bytes: 0,
      googleRequests: 0,
      foldersPerSec: 0,
      filesPerSec: 0,
      message: 'Initializing background discovery job...',
      elapsed: 0
    });
    lastProgressTimeRef.current = Date.now();

    try {
      console.log(`[Frontend] Requesting discovery start for sourceId=${sourceId}, sessionId=${sessionId}`);
      const job = await migrationApi.startDiscovery(sourceId, sessionId);
      const activeJobId = job.jobId || job.id;
      console.log(`[Frontend] Discovery job created/resumed with jobId=${activeJobId}`);
      setJobId(activeJobId);
    } catch (err: any) {
      const errMsg = err.message || 'Failed to initialize discovery';
      console.error(`[Frontend] startDiscovery failed:`, errMsg);
      setInitError(errMsg);
      onError(errMsg);
      hasStartedRef.current = false;
    }
  };

  useEffect(() => {
    hasStartedRef.current = true;
    startDiscoveryProcess();
  }, [sourceId, sessionId]);

  useEffect(() => {
    if (!jobId) return;

    let pollTimeout: number;
    let isActive = true;

    // Frontend 30s Stall Detection Check
    const stallInterval = setInterval(() => {
      if (completed || initError) return;
      const timeSinceLastProgress = Date.now() - lastProgressTimeRef.current;
      if (timeSinceLastProgress > 30000 && stats.folders === 0 && stats.files === 0) {
        console.warn(`[Frontend] Discovery stalled for > 30 seconds without progress.`);
        const stallMsg = 'Discovery job timed out after 30 seconds of inactivity.';
        setInitError(stallMsg);
        onError(stallMsg);
        isActive = false;
        if (abortControllerRef.current) abortControllerRef.current.abort();
      }
    }, 5000);

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
           throw new Error(`Stream rejected with HTTP status ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (isActive) {
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
              lastProgressTimeRef.current = Date.now();

              if (data.error) {
                onError(data.error);
                setInitError(data.error);
                isActive = false;
                break;
              }

              if (data.event === 'SCAN_COMPLETED') {
                setCompleted(true);
                setFinalSummary(data.data);
                isActive = false;
                onComplete(data.data);
                break;
              }

              const isScanning = (data.foldersFound > 0 || data.filesFound > 0);
              const currentStatus = isScanning ? 'SCANNING' : ((data.status || 'QUEUED').toUpperCase());
              
              setStats({
                status: currentStatus,
                folders: data.foldersFound || 0,
                files: data.filesFound || 0,
                bytes: data.bytesFound || 0,
                googleRequests: data.googleRequests || (data.foldersFound ? data.foldersFound + 1 : 1),
                foldersPerSec: data.foldersPerSec || 0,
                filesPerSec: data.filesPerSec || 0,
                elapsed: data.elapsed || 0,
                message: data.currentFolder 
                  ? `Scanning folder: ${data.currentFolder}` 
                  : (data.currentFile ? `Scanning file: ${data.currentFile}` : `Scanning Google Drive...`)
              });

              if (data.status === 'completed' && !completed) {
                 setCompleted(true);
                 setFinalSummary({
                   totalFolders: data.foldersFound || 0,
                   totalFiles: data.filesFound || 0,
                   totalBytes: data.bytesFound || 0,
                   manifestId: data.manifestId
                 });
                 isActive = false;
                 onComplete(data);
                 break;
              }

            } catch (e) {
              console.warn('[Frontend] Non-fatal SSE parse update:', e);
            }
          }
        }
      } catch (error: any) {
         if (error.name === 'AbortError') return;
         console.warn('[Frontend] Stream disconnected, attempting polling fallback...', error.message);
         
         if (isActive) {
            try {
              const details = await migrationApi.getJobDetails(jobId);
              if (details) {
                lastProgressTimeRef.current = Date.now();
                const isScanning = (details.foldersFound > 0 || details.filesFound > 0);
                setStats({
                  status: isScanning ? 'SCANNING' : (details.status || 'QUEUED').toUpperCase(),
                  folders: details.foldersFound || 0,
                  files: details.filesFound || 0,
                  bytes: details.bytesFound || 0,
                  googleRequests: details.foldersFound || 1,
                  foldersPerSec: details.foldersPerSec || 0,
                  filesPerSec: details.filesPerSec || 0,
                  elapsed: details.elapsed || 0,
                  message: details.currentFolder ? `Scanning folder: ${details.currentFolder}` : 'Scanning Google Drive...'
                });

                if (details.status === 'completed') {
                  setCompleted(true);
                  setFinalSummary(details);
                  isActive = false;
                  onComplete(details);
                  return;
                } else if (details.status === 'failed') {
                  setInitError('Discovery job failed during background execution.');
                  onError('Discovery job failed during background execution.');
                  isActive = false;
                  return;
                }
              }
            } catch (pollErr: any) {
              console.error('[Frontend] Polling fallback error:', pollErr);
            }
            pollTimeout = window.setTimeout(streamDiscovery, 1000);
         }
      }
    };

    streamDiscovery();

    return () => {
      isActive = false;
      clearInterval(stallInterval);
      if (abortControllerRef.current) abortControllerRef.current.abort();
      clearTimeout(pollTimeout);
    };
  }, [jobId, onComplete, onError]);

  if (initError) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 p-6 rounded-lg border border-red-200 dark:border-red-800 text-center shadow-sm">
        <AlertTriangle className="w-10 h-10 text-red-500 mx-auto mb-3 animate-bounce" />
        <h3 className="text-lg font-semibold text-red-800 dark:text-red-300 mb-2">Discovery Phase Error</h3>
        <p className="text-sm text-red-600 dark:text-red-400 mb-4">{initError}</p>
        <button
          onClick={() => {
            hasStartedRef.current = true;
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
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{finalSummary.totalFolders || 0}</div>
              <div className="text-sm text-gray-500">Folders</div>
           </div>
           <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded text-center border border-gray-100 dark:border-gray-700">
              <FileIcon className="w-6 h-6 mx-auto mb-2 text-blue-500" />
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{finalSummary.totalFiles || 0}</div>
              <div className="text-sm text-gray-500">Files</div>
           </div>
           <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded text-center border border-gray-100 dark:border-gray-700">
              <span className="block text-2xl mb-2">💾</span>
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{formatBytes(finalSummary.totalBytes || 0)}</div>
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
    switch (status) {
      case 'SCANNING':
        return <span className="px-3 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs font-semibold rounded-full animate-pulse border border-blue-200 dark:border-blue-800">SCANNING</span>;
      case 'PREPARING':
      case 'CONNECTING':
        return <span className="px-3 py-1 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 text-xs font-semibold rounded-full border border-yellow-200 dark:border-yellow-800">CONNECTING</span>;
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
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.folders}</div>
          <div className="text-xs text-indigo-500 font-medium mt-0.5">+{stats.foldersPerSec}/s</div>
          <div className="text-xs text-gray-500 mt-1">Folders Found</div>
        </div>
        <div className="bg-white dark:bg-gray-900 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.files}</div>
          <div className="text-xs text-blue-500 font-medium mt-0.5">+{stats.filesPerSec}/s</div>
          <div className="text-xs text-gray-500 mt-1">Files Found</div>
        </div>
        <div className="bg-white dark:bg-gray-900 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{formatBytes(stats.bytes)}</div>
          <div className="text-xs text-gray-400 font-medium mt-0.5">Total Payload</div>
          <div className="text-xs text-gray-500 mt-1">Total Size</div>
        </div>
        <div className="bg-white dark:bg-gray-900 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{stats.googleRequests}</div>
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

