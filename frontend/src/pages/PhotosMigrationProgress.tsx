import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../api/apiClient';
import { XCircle, ArrowLeft, Loader2, CheckCircle, AlertCircle, RefreshCw, Image, Video, FileText, ExternalLink, HardDrive } from 'lucide-react';
import { toast } from 'react-hot-toast';

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
  totalBytes: number;
  transferredBytes: number;
  currentAction: string;
  destinationFolderId?: string;
  organization?: string;
  failedItemsList: PhotosFailedItem[];
  logs: string[];
}

export default function PhotosMigrationProgress() {
  const navigate = useNavigate();
  const params = useParams<{ jobId?: string }>();
  const [jobId, setJobId] = useState<string | null>(params.jobId || null);

  const [status, setStatus] = useState<PhotosStatus>({
    status: 'preparing',
    percentage: 0,
    totalItems: 0,
    completedItems: 0,
    failedItems: 0,
    pendingItems: 0,
    photosCount: 0,
    videosCount: 0,
    totalBytes: 0,
    transferredBytes: 0,
    currentAction: 'Preparing migration...',
    destinationFolderId: 'root',
    organization: 'FLAT',
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
            totalBytes: res.progress.totalBytes || 0,
            transferredBytes: res.progress.transferredBytes || 0,
            currentAction: res.progress.currentAction || '',
            destinationFolderId: res.destinationFolderId || 'root',
            organization: res.organization || 'FLAT',
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
    try {
      await apiClient(`/api/photos/migrations/${jobId}/pause`, { method: 'POST' });
      toast.success('Migration paused.');
    } catch (e: any) {
      toast.error(e.message || 'Failed to pause migration.');
    }
  };

  const handleResume = async () => {
    if (!jobId) return;
    try {
      await apiClient(`/api/photos/migrations/${jobId}/resume`, { method: 'POST' });
      toast.success('Migration resumed.');
    } catch (e: any) {
      toast.error(e.message || 'Failed to resume migration.');
    }
  };

  const handleCancel = async () => {
    if (!jobId) return;
    try {
      await apiClient(`/api/photos/migrations/${jobId}/cancel`, { method: 'POST' });
      toast.success('Migration cancelled.');
    } catch (e: any) {
      toast.error(e.message || 'Failed to cancel migration.');
    }
  };

  const handleRetryFailed = async (itemIds?: string[]) => {
    if (!jobId) return;
    setRetrying(true);
    try {
      const res = await apiClient(`/api/photos/migrations/${jobId}/retry-failed`, {
        method: 'POST',
        body: JSON.stringify({ itemIds })
      });
      toast.success(`Retrying ${res.retriedCount || 0} failed items.`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to retry items.');
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
    } catch (e: any) {
      toast.error(e.message || 'Failed to fetch report.');
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
      <div className="flex flex-col items-center justify-center h-64 space-y-3">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
        <p className="text-sm text-gray-500 font-medium">Loading migration status...</p>
      </div>
    );
  }

  const isTerminal = ['completed', 'completed_with_errors', 'cancelled', 'failed'].includes(status.status);
  const isAuthRequired = status.currentAction?.includes('AUTH_REQUIRED');

  const driveFolderUrl = status.destinationFolderId && status.destinationFolderId !== 'root'
    ? `https://drive.google.com/drive/folders/${status.destinationFolderId}`
    : `https://drive.google.com/drive/my-drive`;

  return (
    <div className="max-w-5xl mx-auto py-8 space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <button onClick={() => navigate('/dashboard')} className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 mb-2">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to Dashboard
          </button>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center">
            <Image className="w-7 h-7 text-indigo-500 mr-2" /> Google Photos → Google Drive Migration
          </h1>
        </div>

        {/* Action Controls */}
        <div className="flex space-x-3">
          {status.status === 'copying' && (
            <button onClick={handlePause} className="px-4 py-2 bg-amber-600 text-white text-sm font-semibold rounded-lg hover:bg-amber-700 shadow-sm">
              Pause
            </button>
          )}
          {(status.status === 'paused' || isAuthRequired) && (
            <button onClick={handleResume} className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 shadow-sm">
              Resume
            </button>
          )}
          {!isTerminal && (
            <button onClick={handleCancel} className="px-4 py-2 border border-red-300 text-red-600 hover:bg-red-50 text-sm font-semibold rounded-lg dark:border-red-800 dark:text-red-400">
              Cancel
            </button>
          )}
          {isTerminal && (
            <div className="flex space-x-3">
              <a
                href={driveFolderUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center px-4 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 shadow-sm"
              >
                <HardDrive className="w-4 h-4 mr-2" /> Open Google Drive Folder <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
              </a>
              <button onClick={handleFetchReport} className="inline-flex items-center px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 shadow-sm">
                <FileText className="w-4 h-4 mr-2" /> View Report
              </button>
            </div>
          )}
        </div>
      </div>

      {/* AUTH_REQUIRED Warning Banner */}
      {isAuthRequired && (
        <div className="p-4 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-xl flex items-center justify-between">
          <div className="flex items-center space-x-3 text-amber-800 dark:text-amber-300 text-sm font-medium">
            <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
            <span>Google authorization expired or required. Please reconnect your account and click Resume.</span>
          </div>
          <button
            onClick={() => navigate('/migration')}
            className="px-3.5 py-1.5 bg-amber-600 text-white text-xs font-semibold rounded-lg hover:bg-amber-700"
          >
            Reconnect Account
          </button>
        </div>
      )}

      {/* Main Status Card */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 space-y-5">
        {status.status === 'preparing' ? (
          /* Preparation Stage (No 0/0 or 0% shown!) */
          <div className="py-6 flex flex-col items-center justify-center space-y-3 text-center">
            <Loader2 className="w-10 h-10 animate-spin text-indigo-600" />
            <div className="space-y-1">
              <p className="text-lg font-bold text-gray-900 dark:text-white">PREPARING MIGRATION</p>
              <p className="text-sm text-gray-500">Retrieving selected media items and initializing Drive upload queue...</p>
            </div>
          </div>
        ) : (
          /* Active / Completed Stage */
          <>
            <div className="flex justify-between items-center">
              <div>
                <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                  status.status === 'completed' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' :
                  status.status === 'completed_with_errors' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' :
                  status.status === 'paused' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300' :
                  status.status === 'failed' ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' :
                  'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300'
                }`}>
                  {status.status.replace(/_/g, ' ')}
                </span>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 font-medium">{status.currentAction || 'Migrating media items...'}</p>
              </div>

              <div className="text-right">
                <span className="text-3xl font-black text-gray-900 dark:text-white">{status.percentage}%</span>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-gray-100 dark:bg-gray-700 h-4 rounded-full overflow-hidden p-0.5 border border-gray-200 dark:border-gray-600">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  status.status === 'completed' ? 'bg-green-500' :
                  status.status === 'completed_with_errors' ? 'bg-amber-500' :
                  status.status === 'failed' ? 'bg-red-500' : 'bg-indigo-600 animate-pulse'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, status.percentage))}%` }}
              />
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-gray-100 dark:border-gray-700">
              <div className="p-3.5 bg-gray-50 dark:bg-gray-900/50 rounded-xl">
                <div className="flex items-center text-xs text-gray-500 mb-1">
                  <Image className="w-3.5 h-3.5 mr-1 text-blue-500" /> Selected Photos
                </div>
                <p className="text-xl font-extrabold text-gray-900 dark:text-white">{status.photosCount.toLocaleString()}</p>
              </div>

              <div className="p-3.5 bg-gray-50 dark:bg-gray-900/50 rounded-lg">
                <div className="flex items-center text-xs text-gray-500 mb-1">
                  <Video className="w-3.5 h-3.5 mr-1 text-purple-500" /> Selected Videos
                </div>
                <p className="text-xl font-extrabold text-gray-900 dark:text-white">{status.videosCount.toLocaleString()}</p>
              </div>

              <div className="p-3.5 bg-gray-50 dark:bg-gray-900/50 rounded-lg">
                <div className="flex items-center text-xs text-gray-500 mb-1">
                  <CheckCircle className="w-3.5 h-3.5 mr-1 text-green-500" /> Completed / Verified
                </div>
                <p className="text-xl font-extrabold text-gray-900 dark:text-white">
                  {status.completedItems.toLocaleString()} / {status.totalItems.toLocaleString()}
                </p>
              </div>

              <div className="p-3.5 bg-gray-50 dark:bg-gray-900/50 rounded-lg">
                <div className="flex items-center text-xs text-gray-500 mb-1">
                  <HardDrive className="w-3.5 h-3.5 mr-1 text-indigo-500" /> Transferred Size
                </div>
                <p className="text-xl font-extrabold text-gray-900 dark:text-white">{formatBytes(status.transferredBytes)}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">of {formatBytes(status.totalBytes)}</p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Failed Items Section */}
      {status.failedItemsList.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-red-200 dark:border-red-900/50 p-6 space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-bold text-red-700 dark:text-red-400 flex items-center">
              <AlertCircle className="w-5 h-5 mr-2" /> Failed Items ({status.failedItemsList.length})
            </h3>
            <button
              onClick={() => handleRetryFailed()}
              disabled={retrying}
              className="inline-flex items-center px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg shadow-sm disabled:opacity-50"
            >
              {retrying ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
              Retry All Failed
            </button>
          </div>

          <div className="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-xl">
            <table className="w-full text-left text-xs text-gray-600 dark:text-gray-300">
              <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 font-bold text-gray-700 dark:text-gray-200">
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
                        className="text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 font-bold"
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
                <FileText className="w-6 h-6 text-indigo-500 mr-2" /> Google Photos → Google Drive Report
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
                <div>Total Selected: <strong>{report.summary?.totalItems?.toLocaleString()}</strong></div>
                <div>Photos: <strong>{report.summary?.photosCount?.toLocaleString()}</strong></div>
                <div>Videos: <strong>{report.summary?.videosCount?.toLocaleString()}</strong></div>
                <div>Transferred Size: <strong>{formatBytes(report.summary?.transferredBytes || 0)}</strong></div>
                <div>Successfully Verified: <strong className="text-green-600">{report.summary?.completedItems?.toLocaleString()}</strong></div>
                <div>Failed: <strong className="text-red-600">{report.summary?.failedItems?.toLocaleString()}</strong></div>
              </div>

              {report.limitationsNotices && (
                <div className="p-3 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-800 dark:text-indigo-300 rounded-lg text-xs space-y-1 border border-indigo-200 dark:border-indigo-800">
                  <p className="font-semibold flex items-center">Notices:</p>
                  {report.limitationsNotices.map((notice: string, idx: number) => (
                    <p key={idx}>• {notice}</p>
                  ))}
                </div>
              )}
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
