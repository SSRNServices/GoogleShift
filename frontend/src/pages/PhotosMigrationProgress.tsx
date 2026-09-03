import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../api/apiClient';
import { XCircle, ArrowLeft, Loader2, CheckCircle, AlertCircle, RefreshCw, Image, Video, FolderArchive, FileText } from 'lucide-react';

interface PhotosFailedItem {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  retryCount: number;
  error: string;
}

interface PhotosStatus {
  status: string;
  percentage: number;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  pendingItems: number;
  photosCount: number;
  videosCount: number;
  albumsCount: number;
  totalBytes: number;
  transferredBytes: number;
  currentAction: string;
  failedItemsList: PhotosFailedItem[];
  logs: string[];
}

export default function PhotosMigrationProgress() {
  const navigate = useNavigate();
  const params = useParams<{ jobId?: string }>();
  const [jobId, setJobId] = useState<string | null>(params.jobId || null);

  const [status, setStatus] = useState<PhotosStatus>({
    status: 'idle',
    percentage: 0,
    totalItems: 0,
    completedItems: 0,
    failedItems: 0,
    pendingItems: 0,
    photosCount: 0,
    videosCount: 0,
    albumsCount: 0,
    totalBytes: 0,
    transferredBytes: 0,
    currentAction: '',
    failedItemsList: [],
    logs: []
  });

  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [report, setReport] = useState<any | null>(null);
  const [showReport, setShowReport] = useState(false);

  useEffect(() => {
    const fetchCurrentPhotosJob = async () => {
      try {
        if (!jobId) {
          const res = await apiClient('/api/photos/migrations/current');
          if (res && res.jobId) {
            setJobId(res.jobId);
          }
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchCurrentPhotosJob();
  }, [jobId]);

  useEffect(() => {
    if (!jobId) return;

    const pollStatus = async () => {
      try {
        const res = await apiClient(`/api/photos/migrations/${jobId}`);
        if (res && res.progress) {
          setStatus({
            status: res.status,
            percentage: res.progress.percentage || 0,
            totalItems: res.progress.totalItems || 0,
            completedItems: res.progress.completedItems || 0,
            failedItems: res.progress.failedItems || 0,
            pendingItems: res.progress.pendingItems || 0,
            photosCount: res.progress.photosCount || 0,
            videosCount: res.progress.videosCount || 0,
            albumsCount: res.progress.albumsCount || 0,
            totalBytes: res.progress.totalBytes || 0,
            transferredBytes: res.progress.transferredBytes || 0,
            currentAction: res.progress.currentAction || '',
            failedItemsList: res.failedItems || [],
            logs: res.logs || []
          });
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    };

    pollStatus();
    const interval = setInterval(pollStatus, 2500);
    return () => clearInterval(interval);
  }, [jobId]);

  const handlePause = async () => {
    if (!jobId) return;
    await apiClient(`/api/photos/migrations/${jobId}/pause`, { method: 'POST' });
  };

  const handleResume = async () => {
    if (!jobId) return;
    await apiClient(`/api/photos/migrations/${jobId}/resume`, { method: 'POST' });
  };

  const handleCancel = async () => {
    if (!jobId) return;
    await apiClient(`/api/photos/migrations/${jobId}/cancel`, { method: 'POST' });
  };

  const handleRetryFailed = async (itemIds?: string[]) => {
    if (!jobId) return;
    setRetrying(true);
    try {
      await apiClient(`/api/photos/migrations/${jobId}/retry-failed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds })
      });
    } catch (e) {
      console.error(e);
    } finally {
      setRetrying(false);
    }
  };

  const handleFetchReport = async () => {
    if (!jobId) return;
    try {
      const res = await apiClient(`/api/photos/migrations/${jobId}/report`);
      setReport(res);
      setShowReport(true);
    } catch (e) {
      console.error(e);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  const isTerminal = ['completed', 'completed_with_errors', 'cancelled', 'failed'].includes(status.status);

  return (
    <div className="max-w-5xl mx-auto py-8 space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <button onClick={() => navigate('/dashboard')} className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 mb-2">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to Dashboard
          </button>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center">
            <Image className="w-7 h-7 text-indigo-500 mr-2" /> Google Photos Migration Status
          </h1>
        </div>

        {/* Action Controls */}
        <div className="flex space-x-3">
          {status.status === 'copying' && (
            <button onClick={handlePause} className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700">
              Pause
            </button>
          )}
          {status.status === 'paused' && (
            <button onClick={handleResume} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700">
              Resume
            </button>
          )}
          {!isTerminal && (
            <button onClick={handleCancel} className="px-4 py-2 border border-red-300 text-red-600 hover:bg-red-50 text-sm font-medium rounded-lg dark:border-red-800 dark:text-red-400">
              Cancel
            </button>
          )}
          {isTerminal && (
            <button onClick={handleFetchReport} className="inline-flex items-center px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700">
              <FileText className="w-4 h-4 mr-2" /> View Full Report
            </button>
          )}
        </div>
      </div>

      {/* Main Status & Progress Bar */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 space-y-4">
        <div className="flex justify-between items-center">
          <div>
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${
              status.status === 'completed' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' :
              status.status === 'completed_with_errors' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' :
              status.status === 'paused' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300' :
              status.status === 'failed' ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' :
              'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
            }`}>
              {status.status.replace(/_/g, ' ')}
            </span>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{status.currentAction || 'Migrating media items...'}</p>
          </div>

          <div className="text-right">
            <span className="text-3xl font-extrabold text-gray-900 dark:text-white">{status.percentage}%</span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-gray-200 dark:bg-gray-700 h-4 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${
              status.status === 'completed' ? 'bg-green-500' :
              status.status === 'completed_with_errors' ? 'bg-amber-500' :
              status.status === 'failed' ? 'bg-red-500' : 'bg-indigo-600 animate-pulse'
            }`}
            style={{ width: `${Math.min(100, Math.max(0, status.percentage))}%` }}
          />
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-gray-100 dark:border-gray-700">
          <div className="p-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg">
            <div className="flex items-center text-xs text-gray-500 mb-1">
              <Image className="w-3.5 h-3.5 mr-1 text-blue-500" /> Photos
            </div>
            <p className="text-lg font-bold text-gray-900 dark:text-white">{status.photosCount.toLocaleString()}</p>
          </div>

          <div className="p-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg">
            <div className="flex items-center text-xs text-gray-500 mb-1">
              <Video className="w-3.5 h-3.5 mr-1 text-purple-500" /> Videos
            </div>
            <p className="text-lg font-bold text-gray-900 dark:text-white">{status.videosCount.toLocaleString()}</p>
          </div>

          <div className="p-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg">
            <div className="flex items-center text-xs text-gray-500 mb-1">
              <FolderArchive className="w-3.5 h-3.5 mr-1 text-amber-500" /> Albums
            </div>
            <p className="text-lg font-bold text-gray-900 dark:text-white">{status.albumsCount.toLocaleString()}</p>
          </div>

          <div className="p-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg">
            <div className="flex items-center text-xs text-gray-500 mb-1">
              <CheckCircle className="w-3.5 h-3.5 mr-1 text-green-500" /> Completed
            </div>
            <p className="text-lg font-bold text-gray-900 dark:text-white">
              {status.completedItems.toLocaleString()} / {status.totalItems.toLocaleString()}
            </p>
            <p className="text-[10px] text-gray-400 mt-0.5">{formatBytes(status.transferredBytes)} transferred</p>
          </div>
        </div>
      </div>

      {/* Failed Items Section */}
      {status.failedItemsList.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-red-200 dark:border-red-900/50 p-6 space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-bold text-red-700 dark:text-red-400 flex items-center">
              <AlertCircle className="w-5 h-5 mr-2" /> Failed Media Items ({status.failedItemsList.length})
            </h3>
            <button
              onClick={() => handleRetryFailed()}
              disabled={retrying}
              className="inline-flex items-center px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-md shadow-sm disabled:opacity-50"
            >
              {retrying ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
              Retry All Failed
            </button>
          </div>

          <div className="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-lg">
            <table className="w-full text-left text-xs text-gray-600 dark:text-gray-300">
              <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 font-semibold text-gray-700 dark:text-gray-200">
                <tr>
                  <th className="p-3">Filename</th>
                  <th className="p-3">Type</th>
                  <th className="p-3">Error</th>
                  <th className="p-3 text-center">Retries</th>
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {status.failedItemsList.map(item => (
                  <tr key={item.id} className="hover:bg-gray-50 dark:hover:bg-gray-900/30">
                    <td className="p-3 font-medium text-gray-900 dark:text-white truncate max-w-xs">{item.filename}</td>
                    <td className="p-3">{item.mediaType}</td>
                    <td className="p-3 text-red-600 dark:text-red-400 truncate max-w-xs">{item.error}</td>
                    <td className="p-3 text-center">{item.retryCount}</td>
                    <td className="p-3 text-right">
                      <button
                        onClick={() => handleRetryFailed([item.id])}
                        disabled={retrying}
                        className="text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 font-medium"
                      >
                        Retry
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Migration Report Modal */}
      {showReport && report && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-4 max-h-[85vh] overflow-y-auto border border-gray-200 dark:border-gray-700">
            <div className="flex justify-between items-start border-b border-gray-100 dark:border-gray-700 pb-3">
              <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center">
                <FileText className="w-6 h-6 text-indigo-500 mr-2" /> Google Photos Migration Report
              </h3>
              <button onClick={() => setShowReport(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                <XCircle className="w-6 h-6" />
              </button>
            </div>

            <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
              <p><strong>Source:</strong> {report.sourceEmail || 'N/A'}</p>
              <p><strong>Destination:</strong> {report.destinationEmail || 'N/A'}</p>
              <p><strong>Status:</strong> <span className="font-semibold text-indigo-600 dark:text-indigo-400">{report.status}</span></p>

              <div className="grid grid-cols-2 gap-4 bg-gray-50 dark:bg-gray-900/50 p-4 rounded-xl">
                <div>Total Discovered: <strong>{report.summary?.totalItems?.toLocaleString()}</strong></div>
                <div>Photos: <strong>{report.summary?.photosCount?.toLocaleString()}</strong></div>
                <div>Videos: <strong>{report.summary?.videosCount?.toLocaleString()}</strong></div>
                <div>Albums Reconstructed: <strong>{report.summary?.albumsReconstructed} / {report.summary?.albumsDiscovered}</strong></div>
                <div>Successfully Migrated: <strong className="text-green-600">{report.summary?.completedItems?.toLocaleString()}</strong></div>
                <div>Failed: <strong className="text-red-600">{report.summary?.failedItems?.toLocaleString()}</strong></div>
              </div>

              {/* API Limitations Notice */}
              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 rounded-lg text-xs space-y-1 border border-amber-200 dark:border-amber-800">
                <p className="font-semibold flex items-center"><AlertCircle className="w-4 h-4 mr-1" /> API Limitations Notice:</p>
                {report.limitationsNotices?.map((notice: string, idx: number) => (
                  <p key={idx}>• {notice}</p>
                ))}
              </div>
            </div>

            <div className="flex justify-end pt-3 border-t border-gray-100 dark:border-gray-700">
              <button onClick={() => setShowReport(false)} className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 text-sm">
                Close Report
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
