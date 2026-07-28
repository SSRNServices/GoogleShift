import { useEffect, useState } from 'react';
import { API_URL } from '../config/api';
import { Loader2, FolderOpen, File as FileIcon, AlertTriangle, CheckCircle } from 'lucide-react';

interface DiscoveryScannerProps {
  sourceId: string;
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

export function DiscoveryScanner({ sourceId, onComplete, onError }: DiscoveryScannerProps) {
  const [stats, setStats] = useState({
    folders: 0,
    files: 0,
    bytes: 0,
    message: 'Initializing discovery...'
  });
  
  const [completed, setCompleted] = useState(false);
  const [finalSummary, setFinalSummary] = useState<any>(null);

  useEffect(() => {
    let eventSource: EventSource;

    const startScan = async () => {
      // The backend expects a comma separated list of items
      const itemsParam = `${sourceId}:folder`;
      eventSource = new EventSource(`${API_URL}/api/drive/source/root?items=${encodeURIComponent(itemsParam)}`, { withCredentials: true });

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'connected') return;
          
          if (data.event === 'SCAN_FOLDER') {
             setStats({
               folders: data.data.totalFolders,
               files: data.data.totalFiles,
               bytes: data.data.totalBytes,
               message: `Scanning folder: ${data.data.folderName}`
             });
          } else if (data.event === 'SCAN_COMPLETED') {
             setCompleted(true);
             setFinalSummary(data.data);
          } else if (data.event === 'CLOSE') {
             eventSource.close();
             if (finalSummary || data.data) {
                onComplete(finalSummary || data.data);
             }
          } else if (data.event === 'ERROR') {
             onError(data.data.message);
             eventSource.close();
          }
        } catch (e) {
          console.error('Failed to parse scan event', e);
        }
      };

      eventSource.onerror = () => {
         eventSource.close();
         if (!completed) onError('Connection lost during discovery scan.');
      };
    };

    startScan();

    return () => {
      if (eventSource) eventSource.close();
    };
  }, [sourceId]);

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
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{finalSummary.folderCount || 0}</div>
              <div className="text-sm text-gray-500">Folders</div>
           </div>
           <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded text-center border border-gray-100 dark:border-gray-700">
              <FileIcon className="w-6 h-6 mx-auto mb-2 text-blue-500" />
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{finalSummary.fileCount || 0}</div>
              <div className="text-sm text-gray-500">Files</div>
           </div>
           <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded text-center border border-gray-100 dark:border-gray-700">
              <span className="block text-2xl mb-2">💾</span>
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{formatBytes(finalSummary.totalBytes || 0)}</div>
              <div className="text-sm text-gray-500">Total Size</div>
           </div>
           <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded text-center border border-gray-100 dark:border-gray-700">
              <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-yellow-500" />
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{finalSummary.unsupported || 0}</div>
              <div className="text-sm text-gray-500">Unsupported</div>
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
      </div>
    </div>
  );
}
