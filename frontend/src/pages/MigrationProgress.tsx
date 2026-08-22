import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { migrationApi } from '../api/migrationApi';
import { XCircle, ArrowLeft, Loader2, CheckCircle, AlertCircle, AlertTriangle, RefreshCw, Zap } from 'lucide-react';
import { API_URL } from '../config/api';
import { useAuthStore } from '../store/useAuthStore';

interface FailedItemReport {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  retryCount: number;
  error: string;
  classification: string;
  googleReason?: string;
  httpStatus?: number;
  retryable?: boolean;
  actionRequired?: string;
  retryExhausted: boolean;
}

interface MigrationStatus {
  status: string;
  percentage: number;
  bytePercentage?: number;
  filePercentage?: number;
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
  remainingSeconds: number | null;
  stalled?: boolean;
  recovering?: boolean;
  retryCount?: number;
  logs: string[];
  failedItems?: FailedItemReport[];
  failureReason?: string;
}

export default function MigrationProgress() {
  const navigate = useNavigate();
  const params = useParams<{ jobId?: string }>();
  const [searchParams] = useSearchParams();

  const queryJobId = searchParams.get('jobId') || params.jobId || null;
  const [jobId, setJobId] = useState<string | null>(queryJobId);

  const [status, setStatus] = useState<MigrationStatus>({
    status: 'idle',
    percentage: 0,
    bytePercentage: 0,
    filePercentage: 0,
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
    remainingSeconds: null,
    stalled: false,
    recovering: false,
    retryCount: 0,
    logs: [],
    failedItems: []
  });

  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED'>('CONNECTED');

  const speedSamplesRef = useRef<number[]>([]);
  const [averageSpeed, setAverageSpeed] = useState(0);
  const lastSequenceRef = useRef<number>(0);
  const currentJobIdRef = useRef<string | null>(jobId);

  useEffect(() => {
    currentJobIdRef.current = jobId;
  }, [jobId]);

  const fetchCurrentJob = useCallback(async () => {
    try {
      setLoading(true);
      setConnectionError(null);
      const data = await migrationApi.getCurrent();
      if (data && data.jobId) {
        setJobId(data.jobId);
      } else {
        setLoading(false);
      }
    } catch (err: unknown) {
      console.error(err);
      setConnectionError(err instanceof Error ? err.message : 'Failed to fetch current migration job');
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!queryJobId) {
      const timer = setTimeout(() => {
        fetchCurrentJob();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [queryJobId, fetchCurrentJob]);

  useEffect(() => {
    if (!jobId) return;
    const hydrateFromBackend = async () => {
      try {
        setLoading(true);
        setConnectionError(null);
        const details = await migrationApi.getJobDetails(jobId);
        if (details && details.progress) {
          if (details.sequenceNumber && details.sequenceNumber > lastSequenceRef.current) {
            lastSequenceRef.current = details.sequenceNumber;
          }
          setStatus({
            status: details.status || 'idle',
            percentage: details.progress.percentage || 0,
            bytePercentage: details.progress.bytePercentage || 0,
            filePercentage: details.progress.filePercentage || 0,
            totalFolders: details.progress.totalFolders || 0,
            totalFiles: details.progress.totalFiles || 0,
            completedFiles: details.progress.completedFiles || 0,
            failedFiles: details.progress.failedFiles || 0,
            totalBytes: Number(details.progress.totalBytes || 0),
            transferredBytes: Number(details.progress.transferredBytes || 0),
            currentFile: details.progress.currentFile || '',
            currentFolder: details.progress.currentFolder || '',
            currentAction: details.progress.currentAction || '',
            speedBytesPerSecond: details.progress.speedBytesPerSecond || 0,
            remainingSeconds: details.progress.remainingSeconds || null,
            stalled: false,
            recovering: false,
            retryCount: 0,
            logs: details.logs || [],
            failedItems: details.failedItems || [],
            failureReason: details.failureReason
          });
          if (details.progress.averageSpeed && details.progress.averageSpeed > 0) {
            setAverageSpeed(details.progress.averageSpeed);
          }
        }
        setLoading(false);
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.warn('[MigrationProgress] Hydration warning:', err.message);
        }
        setLoading(false);
      }
    };
    hydrateFromBackend();
  }, [jobId]);

  useEffect(() => {
    if (!jobId) return;

    // Periodic HTTP reconciliation poll to guarantee state sync with backend
    const reconciliationInterval = setInterval(async () => {
      try {
        const details = await migrationApi.getJobDetails(jobId);
        if (details && details.progress) {
          if (details.sequenceNumber && details.sequenceNumber < lastSequenceRef.current) {
            return; // Ignore older snapshot
          }
          if (details.sequenceNumber) {
            lastSequenceRef.current = details.sequenceNumber;
          }
          setStatus(prev => ({
            ...prev,
            status: details.status || prev.status,
            percentage: details.progress.percentage || prev.percentage,
            bytePercentage: details.progress.bytePercentage || prev.bytePercentage,
            filePercentage: details.progress.filePercentage || prev.filePercentage,
            totalFolders: details.progress.totalFolders || prev.totalFolders,
            totalFiles: details.progress.totalFiles || prev.totalFiles,
            completedFiles: details.progress.completedFiles || prev.completedFiles,
            failedFiles: details.progress.failedFiles || prev.failedFiles,
            totalBytes: Number(details.progress.totalBytes || prev.totalBytes),
            transferredBytes: Number(details.progress.transferredBytes || prev.transferredBytes),
            currentFile: details.progress.currentFile || prev.currentFile,
            currentFolder: details.progress.currentFolder || prev.currentFolder,
            currentAction: details.progress.currentAction || prev.currentAction,
            speedBytesPerSecond: details.progress.speedBytesPerSecond || prev.speedBytesPerSecond,
            remainingSeconds: details.progress.remainingSeconds ?? prev.remainingSeconds,
            logs: details.logs || prev.logs,
            failedItems: details.failedItems || prev.failedItems,
            failureReason: details.failureReason || prev.failureReason
          }));
        }
      } catch (e) {
        console.warn('[MigrationProgress] Reconciliation warning:', e);
      }
    }, 3000);

    const { accessToken } = useAuthStore.getState();
    const tokenParam = accessToken ? `?token=${encodeURIComponent(accessToken)}` : '';
    const sseUrl = `${API_URL}/api/migrations/${jobId}/status${tokenParam}`;

    const eventSource = new EventSource(sseUrl, {
      withCredentials: true
    });

    const sseTimeout = setTimeout(() => {
      setLoading(false);
      setConnectionState('CONNECTED');
    }, 5000);

    eventSource.onopen = () => {
      setLoading(false);
      setConnectionState('CONNECTED');
    };

    eventSource.onerror = () => {
      console.warn('[MigrationProgress] SSE connection reconnecting...');
      setLoading(false);
      setConnectionState('RECONNECTING');
    };

    eventSource.onmessage = (event) => {
      try {
        clearTimeout(sseTimeout);
        if (event.data === 'heartbeat') return;

        const data = JSON.parse(event.data);
        if (data.error && data.error === 'Job not found') {
          console.error('SSE Error:', data.error);
          setConnectionError(data.error);
          setLoading(false);
          eventSource.close();
          clearInterval(reconciliationInterval);
          return;
        }

        // Validate jobId & sequenceNumber to prevent stale or out-of-order state overwrites
        if (data.jobId && data.jobId !== currentJobIdRef.current) return;
        if (data.sequenceNumber && data.sequenceNumber < lastSequenceRef.current) return;
        if (data.sequenceNumber) lastSequenceRef.current = data.sequenceNumber;

        if (data.averageSpeed && data.averageSpeed > 0) {
          setAverageSpeed(data.averageSpeed);
        } else if (data.speedBytesPerSecond > 0) {
          speedSamplesRef.current.push(data.speedBytesPerSecond);
          if (speedSamplesRef.current.length > 10) speedSamplesRef.current.shift();
          const avg = speedSamplesRef.current.reduce((a, b) => a + b, 0) / speedSamplesRef.current.length;
          setAverageSpeed(avg);
        } else if (data.stalled) {
          setAverageSpeed(0);
        }

        setStatus((prev: MigrationStatus) => {
          const combinedLogs = [...prev.logs];
          if (data.logs && Array.isArray(data.logs)) {
            for (const l of data.logs) {
              if (!combinedLogs.includes(l)) combinedLogs.push(l);
            }
          }
          if (data.currentAction && !combinedLogs.some(l => l.endsWith(data.currentAction!))) {
            combinedLogs.push(`[${new Date().toLocaleTimeString()}] ${data.currentAction}`);
          }
          return {
            ...prev,
            ...data,
            remainingSeconds: data.remainingSeconds ?? null,
            logs: combinedLogs.slice(-100),
            failedItems: data.failedItems || prev.failedItems || [],
            failureReason: data.failureReason || prev.failureReason
          };
        });

        setLoading(false);
        setConnectionState('CONNECTED');
        setConnectionError(null);

        if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(data.status)) {
          eventSource.close();
          clearInterval(reconciliationInterval);
        }
      } catch (e) {
        console.error('Failed to parse SSE data', e);
      }
    };

    return () => {
      clearTimeout(sseTimeout);
      eventSource.close();
      clearInterval(reconciliationInterval);
    };
  }, [jobId]);

  const handleCancel = async () => {
    if (!jobId) return;
    if (!confirm('Are you sure you want to cancel the migration? Active transfers will be aborted.')) return;
    try {
      await migrationApi.discard(jobId);
      setStatus(prev => ({ ...prev, status: 'cancelled' }));
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

  const formatSpeed = (bps: number) => {
    if (!bps || bps === 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bps) / Math.log(k));
    return parseFloat((bps / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatTime = (seconds: number | null) => {
    if (seconds === null || seconds === undefined || seconds <= 0) return null;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <Loader2 className="w-10 h-10 animate-spin text-indigo-600 mb-4" />
        <p className="text-gray-500">Connecting to migration service...</p>
      </div>
    );
  }

  if (connectionError && status.status === 'idle') {
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
              const cur = jobId;
              setJobId(null);
              setTimeout(() => setJobId(cur), 100);
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

  const isFailed = status.status === 'failed';
  const isFinishedSuccess = ['completed', 'completed_with_errors'].includes(status.status);
  const isCompleted = ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status.status);
  const isActive = ['copying', 'preparing', 'queued', 'scanning'].includes(status.status);
  const lastErrorLog = status.failureReason || status.logs?.slice().reverse().find(l => l.includes('FAILED') || l.includes('Error') || l.includes('not authenticated')) || 'Migration encountered an error during execution.';

  const etaDisplay = (() => {
    if (status.status === 'completed' || status.status === 'completed_with_errors') return 'Completed';
    if (status.status === 'failed' || status.status === 'cancelled') return 'N/A';
    if (!isActive) return null;
    if (status.stalled && !status.recovering) return '⚠ Stalled';
    if (status.recovering) return '↺ Recovering...';
    const formatted = formatTime(status.remainingSeconds);
    return formatted ?? 'Calculating...';
  })();

  const byteProgressPct = isFinishedSuccess ? 100 : Math.min(99, status.bytePercentage ?? status.percentage ?? 0);
  const fileProgressPct = isFinishedSuccess ? 100 : Math.min(99, status.filePercentage ?? 0);

  const displayFolder = isCompleted
    ? (status.status === 'completed_with_errors' ? 'Completed with Errors' : (isFailed ? (status.currentFolder || 'Failed') : 'Completed'))
    : (status.currentFolder || status.currentAction || 'Active Migration');

  const displayFile = isCompleted
    ? (status.status === 'completed_with_errors' ? 'Completed with Errors' : (isFailed ? (status.currentFile || 'Failed') : 'Completed'))
    : (status.currentFile || status.currentAction || 'Transferring...');

  return (
    <div className="max-w-5xl mx-auto py-8 space-y-6">

      {/* Connection Interrupted Reconnection Banner */}
      {connectionState === 'RECONNECTING' && !isCompleted && (
        <div className="rounded-xl border p-4 flex items-center gap-3 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-700">
          <RefreshCw className="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin flex-shrink-0" />
          <div>
            <p className="font-medium text-sm text-blue-900 dark:text-blue-200">
              Live connection temporarily interrupted — reconnecting...
            </p>
            <p className="text-xs text-gray-500 mt-0.5">Your migration is continuing safely on the backend server.</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            {isFailed ? (
              <XCircle className="w-6 h-6 text-red-500" />
            ) : isCompleted ? (
              <CheckCircle className="w-6 h-6 text-green-500" />
            ) : status.stalled ? (
              <AlertTriangle className="w-6 h-6 text-yellow-500" />
            ) : (
              <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
            )}
            {isFailed ? 'Migration Failed' : isCompleted ? (status.status === 'completed_with_errors' ? 'Completed with Errors' : 'Migration Completed') : status.stalled ? 'Migration Stalled' : 'Migration in Progress'}
          </h1>
          <p className="text-gray-500 capitalize mt-1">{status.status.replace(/_/g, ' ')}</p>
        </div>

        <div className="flex gap-3">
          {isFailed ? (
            <>
              <button onClick={() => { window.location.href = `${API_URL}/auth/destination`; }} className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 text-sm font-medium">
                Reconnect Destination
              </button>
              <button onClick={() => { window.location.href = `${API_URL}/auth/source`; }} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-medium">
                Reconnect Source
              </button>
              <button onClick={() => navigate('/migration')} className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700 text-sm font-medium">
                Restart Migration
              </button>
            </>
          ) : !isCompleted ? (
            <button onClick={handleCancel} className="flex items-center px-4 py-2 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded hover:bg-red-100 text-sm">
              <XCircle className="w-4 h-4 mr-2" /> Cancel
            </button>
          ) : (
            <button onClick={() => navigate('/migration')} className="flex items-center px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 text-sm">
              <ArrowLeft className="w-4 h-4 mr-2" /> New Migration
            </button>
          )}
        </div>
      </div>

      {/* Stall / Recovery Banner */}
      {status.stalled && !isCompleted && (
        <div className={`rounded-xl border p-4 flex items-center gap-3 ${status.recovering
          ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-700'
          : 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-700'}`}>
          {status.recovering
            ? <RefreshCw className="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin flex-shrink-0" />
            : <AlertTriangle className="w-5 h-5 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />}
          <div>
            <p className={`font-medium text-sm ${status.recovering ? 'text-blue-900 dark:text-blue-200' : 'text-yellow-900 dark:text-yellow-200'}`}>
              {status.recovering
                ? 'Recovering stalled transfer — watchdog is restarting stuck workers...'
                : 'Migration appears stalled — waiting for watchdog recovery...'}
            </p>
            {status.currentFile && (
              <p className="text-xs text-gray-500 mt-0.5 font-mono truncate">Stuck on: {status.currentFile}</p>
            )}
          </div>
        </div>
      )}

      {/* Failure banner */}
      {isFailed && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-5">
          <div className="flex items-start">
            <AlertCircle className="w-6 h-6 text-red-600 dark:text-red-400 mr-3 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="text-base font-semibold text-red-900 dark:text-red-200">Failure Reason</h3>
              <p className="text-sm text-red-700 dark:text-red-300 mt-1 font-mono">{lastErrorLog}</p>
              <div className="mt-3 flex gap-3">
                <button onClick={() => { window.location.href = `${API_URL}/auth/destination`; }} className="text-xs bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 font-medium">
                  Reconnect Destination
                </button>
                <button onClick={() => { window.location.href = `${API_URL}/auth/source`; }} className="text-xs bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 font-medium">
                  Reconnect Source
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main progress card */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">

        {/* ETA row */}
        <div className="flex justify-between items-end mb-4">
          <div>
            <div className="text-xs text-gray-400 mb-1 uppercase tracking-wide">Overall Progress</div>
            <div className="text-3xl font-bold text-gray-900 dark:text-white">
              {status.status === 'scanning' ? 'SCANNING...' : `${byteProgressPct}%`}
            </div>
          </div>
          {etaDisplay && (
            <div className="text-right">
              <div className="text-xs text-gray-400 mb-1 uppercase tracking-wide">ETA</div>
              <div className={`text-xl font-mono font-semibold ${
                status.stalled ? 'text-yellow-600 dark:text-yellow-400' :
                status.recovering ? 'text-blue-600 dark:text-blue-400' :
                'text-gray-900 dark:text-white'
              }`}>
                {etaDisplay}
              </div>
            </div>
          )}
        </div>

        {/* Byte progress bar */}
        <div className="mb-2">
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>Data Transfer</span>
            <span>{formatBytes(status.transferredBytes)} / {formatBytes(status.totalBytes)}</span>
          </div>
          <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-3 overflow-hidden">
            <div
              className={`h-3 rounded-full transition-all duration-500 ${
                status.stalled
                  ? 'bg-yellow-400'
                  : status.recovering
                  ? 'bg-blue-500 animate-pulse'
                  : 'bg-indigo-600'
              }`}
              style={{ width: `${byteProgressPct}%` }}
            />
          </div>
        </div>

        {/* File progress bar */}
        <div className="mb-6">
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>Files Transferred</span>
            <span>{status.completedFiles} success · {status.failedFiles} failed / {status.totalFiles} total</span>
          </div>
          <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
            <div
              className="h-2 rounded-full bg-emerald-500 transition-all duration-500"
              style={{ width: `${fileProgressPct}%` }}
            />
          </div>
        </div>

        {/* Stat grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3">
            <div className="text-xs text-gray-400 mb-1">Current Speed</div>
            <div className="font-semibold text-gray-900 dark:text-white flex items-center gap-1">
              <Zap className="w-3 h-3 text-yellow-400" />
              {status.speedBytesPerSecond > 0 ? formatSpeed(status.speedBytesPerSecond) : (status.stalled ? '0 B/s' : '—')}
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3">
            <div className="text-xs text-gray-400 mb-1">Avg Speed</div>
            <div className="font-semibold text-gray-900 dark:text-white">
              {averageSpeed > 0 ? formatSpeed(averageSpeed) : '—'}
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3">
            <div className="text-xs text-gray-400 mb-1">Failed Files</div>
            <div className={`font-semibold ${status.failedFiles > 0 ? 'text-red-500' : 'text-gray-900 dark:text-white'}`}>
              {status.failedFiles}
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3">
            <div className="text-xs text-gray-400 mb-1">Folders</div>
            <div className="font-semibold text-gray-900 dark:text-white">{status.totalFolders || 0}</div>
          </div>
        </div>
      </div>

      {/* Current operation */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Current Operation</h3>
        <div className="space-y-3">
          <div>
            <div className="text-xs text-gray-400 mb-1">Folder</div>
            <div className="text-sm truncate bg-gray-50 dark:bg-gray-900 p-2 rounded font-mono text-gray-800 dark:text-gray-200">
              {displayFolder}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-400 mb-1">File</div>
            <div className={`text-sm truncate bg-gray-50 dark:bg-gray-900 p-2 rounded font-mono text-gray-800 dark:text-gray-200 ${status.stalled ? 'text-yellow-600 dark:text-yellow-400' : ''}`}>
              {displayFile}
              {status.stalled && status.currentFile && <span className="ml-2 text-xs opacity-70">(stalled)</span>}
            </div>
          </div>
          {status.currentAction && !isCompleted && (
            <div>
              <div className="text-xs text-gray-400 mb-1">Action</div>
              <div className="text-sm truncate bg-gray-50 dark:bg-gray-900 p-2 rounded text-gray-600 dark:text-gray-400">
                {status.currentAction}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Detailed Error Report Card */}
      {(status.failedFiles > 0 || (status.failedItems && status.failedItems.length > 0)) && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-red-200 dark:border-red-900 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h3 className="font-semibold text-red-900 dark:text-red-300 flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-500" />
              Failed Items Report ({status.failedFiles} file{status.failedFiles > 1 ? 's' : ''})
            </h3>
            <div className="flex gap-2">
              <span className="text-xs px-2.5 py-1 rounded-full bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 font-medium">
                Analysis Complete
              </span>
            </div>
          </div>

          <div className="space-y-3 max-h-80 overflow-y-auto">
            {status.failedItems && status.failedItems.length > 0 ? (
              status.failedItems.map((item, idx) => (
                <div key={item.id || idx} className="bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900/60 rounded-lg p-4 font-mono text-xs text-red-900 dark:text-red-200">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <span className="font-bold text-sm text-red-800 dark:text-red-300 truncate max-w-md">{item.name}</span>
                    <span className="bg-red-200 dark:bg-red-900 text-red-800 dark:text-red-200 px-2 py-0.5 rounded text-2xs font-sans font-semibold">
                      Classification: {item.classification}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-gray-600 dark:text-gray-400 mb-2 font-sans">
                    <div><span className="text-gray-400">HTTP Status:</span> {item.httpStatus || 403}</div>
                    <div><span className="text-gray-400">API Reason:</span> {item.googleReason || 'N/A'}</div>
                    <div><span className="text-gray-400">Retryable:</span> {item.retryable ? 'Yes' : 'No'}</div>
                    <div><span className="text-gray-400">Attempts:</span> {item.retryCount}</div>
                  </div>
                  <div className="bg-white dark:bg-gray-900 p-2.5 rounded border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 break-words mb-2">
                    <span className="font-semibold text-gray-500 dark:text-gray-400">Actual Error:</span> {item.error}
                  </div>
                  {item.actionRequired && item.actionRequired !== 'None' && (
                    <div className="bg-amber-50 dark:bg-amber-950/40 p-2 rounded border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300 font-sans text-2xs">
                      <span className="font-semibold">Engine Action:</span> {item.actionRequired}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900/60 rounded-lg p-4 font-mono text-xs text-red-900 dark:text-red-200">
                <p className="font-semibold">Failed files were detected during transfer verification.</p>
                <p className="text-gray-600 dark:text-gray-400 mt-1 font-sans">Check live logs below for details on retry exhaustion and error traces.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Live Logs */}
      <div className="bg-gray-900 rounded-xl shadow-sm border border-gray-800 p-6 h-64 flex flex-col">
        <h3 className="font-semibold text-gray-100 mb-4 flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${status.stalled ? 'bg-yellow-400' : 'bg-green-500 animate-pulse'}`} />
          Live Logs
        </h3>
        <div className="flex-1 overflow-y-auto font-mono text-xs space-y-1 text-gray-300">
          {status.logs.length === 0 ? (
            <div className="text-gray-600 italic">No logs available yet...</div>
          ) : (
            status.logs.map((log: string, idx: number) => (
              <div
                key={idx}
                className={`${
                  log.includes('FAILED') || log.includes('ERROR') || log.includes('Error')
                    ? 'text-red-400'
                    : log.includes('STALLED') || log.includes('STALL')
                    ? 'text-yellow-400'
                    : log.includes('SUCCESS') || log.includes('COMPLETE')
                    ? 'text-green-400'
                    : 'text-gray-300'
                }`}
              >
                {log}
              </div>
            ))
          )}
        </div>
      </div>

    </div>
  );
}
