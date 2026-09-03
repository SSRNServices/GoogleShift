import { useState, useEffect, useRef } from 'react';
import { apiClient } from '../api/apiClient';
import { Loader2, Image, AlertCircle, ExternalLink, X } from 'lucide-react';
import { toast } from 'react-hot-toast';

export interface PhotosSelectionSummary {
  sessionId: string;
  selectedCount: number;
  photosCount: number;
  videosCount: number;
  totalBytes: number;
  manifestId?: string;
}

interface PhotosPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectionComplete: (summary: PhotosSelectionSummary) => void;
}

export function PhotosPickerModal({ isOpen, onClose, onSelectionComplete }: PhotosPickerModalProps) {
  const [statusText, setStatusText] = useState('Initializing Google Photos Picker...');
  const [pickerUri, setPickerUri] = useState<string | null>(null);
  const [stage, setStage] = useState<'INITIALIZING' | 'WAITING' | 'ENUMERATING' | 'COMPLETE' | 'EXPIRED' | 'ERROR'>('INITIALIZING');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const popupRef = useRef<Window | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanupPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const startPickerFlow = async () => {
    try {
      setErrorMsg(null);
      setStage('INITIALIZING');
      setStatusText('Creating Google Photos Picker session...');

      const res = await apiClient('/api/photos/picker/session', { method: 'POST' });
      if (!res.session || !res.session.pickerUri) {
        throw new Error('Failed to obtain Google Photos Picker URL.');
      }

      const session = res.session;
      setPickerUri(session.pickerUri);
      setStage('WAITING');
      setStatusText('Google Photos Picker opened. Please select your photos and videos.');

      // Open official Google Photos Picker in a centered popup window
      const width = 850;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const popup = window.open(
        session.pickerUri,
        'GooglePhotosPicker',
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,status=yes`
      );
      popupRef.current = popup;

      // Start polling status
      cleanupPolling();
      pollIntervalRef.current = setInterval(() => {
        checkSessionStatus(session.id);
      }, 2000);

    } catch (err: any) {
      console.error('[PhotosPickerModal] Error starting picker:', err);
      setStage('ERROR');
      setErrorMsg(err.message || 'Failed to open Google Photos Picker.');
      toast.error(err.message || 'Failed to open Google Photos Picker.');
    }
  };

  const checkSessionStatus = async (sId: string) => {
    try {
      const res = await apiClient(`/api/photos/picker/session/${sId}`);
      const statusData = res.status;

      if (!statusData) return;

      if (statusData.status === 'EXPIRED') {
        cleanupPolling();
        setStage('EXPIRED');
        setStatusText('Picker session expired.');
        return;
      }

      if (statusData.mediaItemsSet || statusData.status === 'SELECTION_COMPLETE') {
        cleanupPolling();
        if (popupRef.current && !popupRef.current.closed) {
          popupRef.current.close();
        }
        await handleEnumeration(sId);
      }
    } catch (err: any) {
      console.warn('[PhotosPickerModal] Polling warning:', err.message);
    }
  };

  const handleEnumeration = async (sId: string) => {
    try {
      setStage('ENUMERATING');
      setStatusText('Retrieving selected media items...');

      const res = await apiClient(`/api/photos/picker/session/${sId}/items`, {
        method: 'POST',
        body: JSON.stringify({})
      });

      if (!res.success) {
        throw new Error(res.error || 'Failed to enumerate selected items.');
      }

      setStage('COMPLETE');
      setStatusText('Selection complete!');

      const summary: PhotosSelectionSummary = {
        sessionId: sId,
        selectedCount: res.selectedCount || 0,
        photosCount: res.photosCount || 0,
        videosCount: res.videosCount || 0,
        totalBytes: res.totalBytes || 0,
        manifestId: res.manifestId
      };

      toast.success(`Selected ${summary.selectedCount} items (${summary.photosCount} photos, ${summary.videosCount} videos)`);
      onSelectionComplete(summary);
      onClose();
    } catch (err: any) {
      console.error('[PhotosPickerModal] Enumeration error:', err);
      setStage('ERROR');
      setErrorMsg(err.message || 'Failed to process selected photos.');
      toast.error(err.message || 'Failed to process selected photos.');
    }
  };

  useEffect(() => {
    if (isOpen) {
      startPickerFlow();
    } else {
      cleanupPolling();
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
    }
    return () => {
      cleanupPolling();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-gray-200 dark:border-gray-700 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-3 border-b border-gray-100 dark:border-gray-700 pb-4 mb-4">
          <div className="p-2.5 bg-indigo-50 dark:bg-indigo-900/40 rounded-xl text-indigo-600 dark:text-indigo-400">
            <Image className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-gray-900 dark:text-white">Google Photos Picker</h3>
            <p className="text-xs text-gray-500">Official Google Photos Media Selection</p>
          </div>
        </div>

        <div className="py-6 text-center space-y-4">
          {stage === 'INITIALIZING' && (
            <div className="flex flex-col items-center justify-center space-y-3">
              <Loader2 className="w-10 h-10 animate-spin text-indigo-600" />
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{statusText}</p>
            </div>
          )}

          {stage === 'WAITING' && (
            <div className="space-y-4">
              <div className="inline-flex p-3 bg-indigo-50 dark:bg-indigo-900/30 rounded-full text-indigo-600 dark:text-indigo-400">
                <Loader2 className="w-8 h-8 animate-spin" />
              </div>
              <div className="space-y-1">
                <p className="text-base font-semibold text-gray-900 dark:text-white">Selection in Progress</p>
                <p className="text-xs text-gray-500 max-w-xs mx-auto">
                  Please select photos and videos in the Google Photos window that popped up, then click "Done" in the Google window.
                </p>
              </div>

              {pickerUri && (
                <div className="pt-2">
                  <a
                    href={pickerUri}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center text-xs font-semibold text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 underline"
                  >
                    <ExternalLink className="w-3.5 h-3.5 mr-1" /> Re-open Google Photos Window
                  </a>
                </div>
              )}
            </div>
          )}

          {stage === 'ENUMERATING' && (
            <div className="flex flex-col items-center justify-center space-y-3">
              <Loader2 className="w-10 h-10 animate-spin text-purple-600" />
              <div className="space-y-1">
                <p className="text-base font-semibold text-gray-900 dark:text-white">Retrieving Selected Media</p>
                <p className="text-xs text-gray-500">Calculating item counts and preparing migration details...</p>
              </div>
            </div>
          )}

          {stage === 'EXPIRED' && (
            <div className="space-y-4">
              <div className="inline-flex p-3 bg-amber-50 dark:bg-amber-900/30 rounded-full text-amber-600 dark:text-amber-400">
                <AlertCircle className="w-8 h-8" />
              </div>
              <div className="space-y-1">
                <p className="text-base font-semibold text-gray-900 dark:text-white">Picker Session Expired</p>
                <p className="text-xs text-gray-500">The selection window timed out. Please try choosing photos again.</p>
              </div>
              <button
                onClick={startPickerFlow}
                className="px-5 py-2 bg-indigo-600 text-white font-medium text-sm rounded-lg hover:bg-indigo-700 shadow-sm"
              >
                Choose Photos Again
              </button>
            </div>
          )}

          {stage === 'ERROR' && (
            <div className="space-y-4">
              <div className="inline-flex p-3 bg-red-50 dark:bg-red-900/30 rounded-full text-red-600 dark:text-red-400">
                <AlertCircle className="w-8 h-8" />
              </div>
              <div className="space-y-1">
                <p className="text-base font-semibold text-gray-900 dark:text-white">Selection Error</p>
                <p className="text-xs text-red-500 font-medium">{errorMsg || 'An unexpected error occurred.'}</p>
              </div>
              <button
                onClick={startPickerFlow}
                className="px-5 py-2 bg-indigo-600 text-white font-medium text-sm rounded-lg hover:bg-indigo-700 shadow-sm"
              >
                Try Again
              </button>
            </div>
          )}
        </div>

        <div className="border-t border-gray-100 dark:border-gray-700 pt-3 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-xs font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
