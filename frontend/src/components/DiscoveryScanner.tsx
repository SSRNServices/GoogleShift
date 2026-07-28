import { useEffect, useState, useRef } from 'react';
import { API_URL } from '../config/api';
import { migrationApi } from '../api/migrationApi';
import { Loader2, FolderOpen, File as FileIcon, AlertTriangle, CheckCircle } from 'lucide-react';

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
  const [stats, setStats] = useState({
    folders: 0,
    files: 0,
    bytes: 0,
    message: 'Initializing background discovery job...',
    elapsed: 0
  });
  
  const [completed, setCompleted] = useState(false);
  const [finalSummary, setFinalSummary] = useState<any>(null);
  
  const abortControllerRef = useRef<AbortController | null>(null);
  const hasStartedRef = useRef(false);

  useEffect(() => {
    let active = true;

    const initDiscovery = async () => {
      if (hasStartedRef.current) return;
      hasStartedRef.current = true;
      try {
        const job = await migrationApi.startDiscovery(sourceId, sessionId);
        if (active) setJobId(job.jobId || job.id);
      } catch (err: any) {
        if (active) {
           onError(err.message || 'Failed to initialize discovery');
           hasStartedRef.current = false; // Allow retry on failure
        }
      }
    };

    initDiscovery();

    return () => { active = false; };
  }, [sourceId, sessionId, onError]);

  useEffect(() => {
    if (!jobId) return;

    let pollTimeout: number;
    let isActive = true;

    const streamDiscovery = async () => {
      try {
        abortControllerRef.current = new AbortController();
        const response = await fetch(`${API_URL}/api/discovery/${jobId}/status`, {
          credentials: 'include',
          signal: abortControllerRef.current.signal
        });

        if (!response.ok || !response.body) {
           throw new Error('Stream rejected');
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
            if (part.startsWith('data: ')) {
              const dataStr = part.substring(6);
              if (!dataStr || dataStr.trim() === '') continue;
              
              try {
                const data = JSON.parse(dataStr);
                
                if (data.error) {
                  onError(data.error);
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
                
                setStats({
                  folders: data.foldersFound || 0,
                  files: data.filesFound || 0,
                  bytes: data.bytesFound || 0,
                  elapsed: data.elapsed || 0,
                  message: data.currentFolder ? `Scanning folder: ${data.currentFolder}` : (data.currentFile ? `Scanning file: ${data.currentFile}` : 'Scanning...')
                });

                if (data.status === 'completed') {
                   // We just wait for SCAN_COMPLETED event which should follow
                }

              } catch (e) {
                console.error('Failed to parse SSE', e);
              }
            }
          }
        }
      } catch (error: any) {
         if (error.name === 'AbortError') return;
         console.warn('Stream failed, falling back to polling...', error);
         
         // Basic polling fallback if stream drops
         if (isActive) {
            pollTimeout = window.setTimeout(streamDiscovery, 2000);
         }
      }
    };

    streamDiscovery();

    return () => {
      isActive = false;
      if (abortControllerRef.current) abortControllerRef.current.abort();
      clearTimeout(pollTimeout);
    };
  }, [jobId, onComplete, onError]);

  if (completed && finalSummary) {
    return (
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="flex items-center space-x-3 text-green-600 mb-6 border-b border-gray-100 dark:border-gray-700 pb-4">
           <CheckCircle className="w-8 h-8" />
           <h3 className="text-xl font-bold">Discovery Complete</h3>
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

  return (
    <div className="bg-gray-50 dark:bg-gray-800 p-8 rounded-lg border border-indigo-100 dark:border-indigo-900/30 text-center relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-1 bg-indigo-100 overflow-hidden">
         <div className="h-full bg-indigo-500 w-1/2 animate-[progress_1s_ease-in-out_infinite]" />
      </div>
      
      <Loader2 className="w-12 h-12 text-indigo-500 mx-auto mb-4 animate-spin" />
      <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">Discovering Files & Folders</h3>
      <p className="text-gray-500 dark:text-gray-400 mb-6">{stats.message}</p>
      
      <div className="flex justify-center items-center space-x-8">
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-700 dark:text-gray-300">{stats.folders}</div>
          <div className="text-sm text-gray-500">Folders Found</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-700 dark:text-gray-300">{stats.files}</div>
          <div className="text-sm text-gray-500">Files Found</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-700 dark:text-gray-300">{formatBytes(stats.bytes)}</div>
          <div className="text-sm text-gray-500">Total Size</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-700 dark:text-gray-300">{(stats.elapsed / 1000).toFixed(1)}s</div>
          <div className="text-sm text-gray-500">Elapsed Time</div>
        </div>
      </div>
    </div>
  );
}
