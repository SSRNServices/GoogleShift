import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { migrationApi } from '../api/migrationApi';
import { Play, Pause, XCircle, ArrowLeft, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { API_URL } from '../config/api';

interface MigrationStatus {
  status: string;
  percentage: number;
  totalFiles: number;
  totalFolders?: number;
  completedFiles: number;
  failedFiles: number;
  totalBytes: number;
  transferredBytes: number;
  currentFile: string;
  currentFolder: string;
  currentAction?: string;
  speedBytesPerSecond: number;
  remainingSeconds: number;
  retryCount?: number;
  logs: string[];
}

export default function MigrationProgress() {
  const navigate = useNavigate();
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<MigrationStatus>({
    status: 'idle',
    percentage: 0,
    totalFolders: 0,
    totalFiles: 0,
    completedFiles: 0,
    failedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    currentFile: '',
    currentFolder: '',
    currentAction: '',
    speedBytesPerSecond: 0,
    remainingSeconds: 0,
    retryCount: 0,
    logs: []
  });

  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const fetchCurrentJob = async () => {
    try {
      setLoading(true);
      setConnectionError(null);
      const data = await migrationApi.getCurrent();
      if (data && data.jobId) {
        setJobId(data.jobId);
      } else {
        // No active job
        setLoading(false);
      }
    } catch (err: any) {
      console.error(err);
      setConnectionError(err.message || 'Failed to fetch current migration job');
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCurrentJob();
  }, []);

  useEffect(() => {
    if (!jobId) return;
    
    // 2. Connect SSE
    const eventSource = new EventSource(`${API_URL}/api/migrations/${jobId}/status`, {
      withCredentials: true
    });
    
    const timeoutId = setTimeout(() => {
      if (loading) {
        setConnectionError('Connection timed out while waiting for migration service.');
        setLoading(false);
        eventSource.close();
      }
    }, 10000);
    
    eventSource.onmessage = (event) => {
      try {
        clearTimeout(timeoutId);
        if (event.data === 'heartbeat') return;

        const data = JSON.parse(event.data);
        if (data.error) {
          console.error('SSE Error:', data.error);
          setConnectionError(data.error);
          setLoading(false);
          eventSource.close();
          return;
        }
        
        setStatus((prev: MigrationStatus) => {
          const newLogs = [...prev.logs];
          if (data.currentAction && data.currentAction !== prev.currentAction) {
             newLogs.push(`[${new Date().toLocaleTimeString()}] ${data.currentAction}`);
          }
          if (data.logs) newLogs.push(...data.logs);

          return {
            ...prev,
            ...data,
            logs: newLogs.slice(-50)
          };
        });
        
        setLoading(false);
        setConnectionError(null);

        if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(data.status)) {
          eventSource.close();
        }
      } catch (e) {
        console.error('Failed to parse SSE data', e);
      }
    };

    eventSource.onerror = (err) => {
      console.error('EventSource failed', err);
      clearTimeout(timeoutId);
      setConnectionError('Lost connection to migration service. Please retry.');
      setLoading(false);
      eventSource.close();
    };

    return () => {
      clearTimeout(timeoutId);
      eventSource.close();
    };
  }, [jobId]);

  const handlePauseResume = async () => {
    if (!jobId) return;
    try {
      if (status.status === 'paused') {
        await migrationApi.resume(jobId);
        setStatus({ ...status, status: 'starting' });
      } else {
        // Assume there is a pause endpoint, but it wasn't specified in `migrationApi.ts`.
        // Let's add it ad-hoc if needed, or just let backend handle it if we create it.
        // I'll skip pause since I only saw discard/resume in the backend. 
        // Wait, the backend has /cancel. Does it have /pause? 
        // I won't implement pause if it's not strictly available. I'll implement cancel.
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleCancel = async () => {
    if (!jobId) return;
    if (!confirm('Are you sure you want to cancel the migration?')) return;
    try {
      await migrationApi.discard(jobId);
      setStatus({ ...status, status: 'cancelled' });
    } catch (e) {
      console.error(e);
    }
  };

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatTime = (seconds: number) => {
    if (!seconds || seconds <= 0) return '00:00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <Loader2 className="w-10 h-10 animate-spin text-indigo-600 mb-4" />
        <p className="text-gray-500">Connecting to migration service...</p>
      </div>
    );
  }

  if (connectionError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
        <h2 className="text-xl font-bold mb-2">Connection Error</h2>
        <p className="text-gray-500 mb-6">{connectionError}</p>
        <button 
          onClick={() => {
            setLoading(true);
            setConnectionError(null);
            if (jobId) {
              const currentJobId = jobId;
              setJobId(null);
              setTimeout(() => setJobId(currentJobId), 100);
            } else {
              fetchCurrentJob();
            }
          }}
          className="bg-indigo-600 text-white px-6 py-2 rounded-md hover:bg-indigo-700"
        >
          Retry Connection
        </button>
      </div>
    );
  }

  if (!jobId) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center max-w-2xl mx-auto border border-gray-200 dark:border-gray-700 mt-8">
        <AlertCircle className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
        <h2 className="text-2xl font-bold mb-2">No Active Migration</h2>
        <p className="text-gray-500 mb-6">There is no active migration running at the moment.</p>
        <button 
          onClick={() => navigate('/migration')}
          className="bg-indigo-600 text-white px-6 py-2 rounded-md hover:bg-indigo-700"
        >
          Start New Migration
        </button>
      </div>
    );
  }

  const isCompleted = ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status.status);

  return (
    <div className="max-w-5xl mx-auto py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center">
            {isCompleted ? <CheckCircle className="w-6 h-6 text-green-500 mr-2" /> : <Loader2 className="w-6 h-6 text-indigo-500 animate-spin mr-2" />}
            Migration {isCompleted ? 'Finished' : 'in Progress'}
          </h1>
          <p className="text-gray-500 capitalize">{status.status}</p>
        </div>
        {!isCompleted && (
          <div className="flex space-x-3">
            {status.status === 'paused' ? (
               <button onClick={handlePauseResume} className="flex items-center px-4 py-2 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 rounded hover:bg-indigo-100">
                 <Play className="w-4 h-4 mr-2" /> Resume
               </button>
            ) : (
               <button onClick={handlePauseResume} disabled className="flex items-center px-4 py-2 bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-500 rounded opacity-50 cursor-not-allowed">
                 <Pause className="w-4 h-4 mr-2" /> Pause (N/A)
               </button>
            )}
            <button onClick={handleCancel} className="flex items-center px-4 py-2 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded hover:bg-red-100">
              <XCircle className="w-4 h-4 mr-2" /> Cancel
            </button>
          </div>
        )}
        {isCompleted && (
          <button onClick={() => navigate('/migration')} className="flex items-center px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700">
            <ArrowLeft className="w-4 h-4 mr-2" /> New Migration
          </button>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-8">
        <div className="mb-6 flex justify-between items-end">
          <div>
            <div className="text-sm text-gray-500 mb-1">{status.status === 'scanning' ? 'Scan Progress' : 'Overall Progress'}</div>
            <div className="text-3xl font-bold text-gray-900 dark:text-white">{status.status === 'scanning' ? 'SCANNING...' : `${status.percentage}%`}</div>
          </div>
          <div className="text-right">
            <div className="text-sm text-gray-500 mb-1">Estimated Time Remaining</div>
            <div className="text-xl font-mono text-gray-900 dark:text-white">{formatTime(status.remainingSeconds)}</div>
          </div>
        </div>

        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4 mb-8 overflow-hidden">
          <div 
            className="bg-indigo-600 h-4 rounded-full transition-all duration-500" 
            style={{ width: `${status.percentage}%` }}
          ></div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          <div>
            <div className="text-xs text-gray-500 mb-1">Data Copied</div>
            <div className="font-semibold">{formatBytes(status.transferredBytes)} / {formatBytes(status.totalBytes)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">Files Copied</div>
            <div className="font-semibold">{status.status === 'scanning' ? `Found: ${status.totalFiles}` : `${status.completedFiles} / ${status.totalFiles}`}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">Folders Discovered</div>
            <div className="font-semibold">{status.totalFolders || 0}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">Failed / Retries</div>
            <div className="font-semibold text-red-500">{status.failedFiles} / {status.retryCount}</div>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-8">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Current Operation</h3>
        <div className="space-y-4">
          <div>
            <div className="text-xs text-gray-500 mb-1">Folder</div>
            <div className="text-sm truncate bg-gray-50 dark:bg-gray-900 p-2 rounded">{status.currentFolder || 'N/A'}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">File</div>
            <div className="text-sm truncate bg-gray-50 dark:bg-gray-900 p-2 rounded">{status.currentFile || 'N/A'}</div>
          </div>
        </div>
      </div>

      <div className="bg-gray-900 rounded-xl shadow-sm border border-gray-800 p-6 h-64 flex flex-col">
        <h3 className="font-semibold text-gray-100 mb-4 flex items-center">
          <span className="w-2 h-2 rounded-full bg-green-500 mr-2 animate-pulse"></span>
          Live Logs
        </h3>
        <div className="flex-1 overflow-y-auto font-mono text-xs space-y-1 text-gray-300">
          {status.logs.length === 0 ? (
            <div className="text-gray-600 italic">No logs available yet...</div>
          ) : (
            status.logs.map((log: string, idx: number) => (
              <div key={idx}>{log}</div>
            ))
          )}
        </div>
      </div>

    </div>
  );
}
