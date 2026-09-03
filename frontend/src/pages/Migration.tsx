import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/apiClient';
import { API_URL } from '../config/api';
import { Check, ChevronRight, Folder, Loader2, ArrowLeft, Cloud, HardDrive, Settings, Play, RefreshCw, Image, Video, CheckCircle2, FolderTree as FolderTreeIcon, Sparkles } from 'lucide-react';
import { migrationApi } from '../api/migrationApi';
import { DiscoveryScanner } from '../components/DiscoveryScanner';
import { SourceFolderSelector } from '../components/SourceFolderSelector';
import { PhotosPickerModal } from '../components/PhotosPickerModal';
import type { PhotosSelectionSummary } from '../components/PhotosPickerModal';
import { useMigrationSessionStore } from '../store/useMigrationSessionStore';
import type { TransferOptionsState } from '../types/transfer';
import type { DriveItem } from '../types/drive';
import { Toaster, toast } from 'react-hot-toast';

type MigrationType = 'DRIVE' | 'PHOTOS';
type Step = 1 | 2 | 3 | 4 | 5 | 6;

function TreeItem({ item, type, onSelect, selectedId }: { item: DriveItem, type: string, onSelect: (it: DriveItem) => void, selectedId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DriveItem[]>([]);
  const [loading, setLoading] = useState(false);

  const isFolder = item.mimeType === 'application/vnd.google-apps.folder';
  const isSelected = selectedId === item.id;

  const handleExpand = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isFolder) return;
    if (!expanded && children.length === 0) {
      setLoading(true);
      try {
        const data = await apiClient(`/api/drive/${type}/folder/${item.id}`);
        setChildren(data.files || []);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    setExpanded(!expanded);
  };

  return (
    <div className="pl-4">
      <div 
        className={`flex items-center py-1.5 px-2 rounded cursor-pointer transition-colors ${isSelected ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-medium' : 'hover:bg-gray-100 dark:hover:bg-gray-800'}`}
        onClick={() => { if(isFolder) onSelect(item); }}
      >
        <div onClick={handleExpand} className="mr-1 cursor-pointer p-0.5">
          {isFolder ? (
            loading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" /> : 
            <ChevronRight className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          ) : <span className="w-4 h-4 inline-block" />}
        </div>
        <Folder className={`w-4 h-4 mr-2 ${isFolder ? 'text-blue-500' : 'text-gray-400'}`} />
        <span className="text-sm truncate">{item.name}</span>
      </div>
      {expanded && children.map(child => (
        <TreeItem key={child.id} item={child} type={type} onSelect={onSelect} selectedId={selectedId} />
      ))}
    </div>
  );
}

function FolderTree({ type, onSelect, selectedId }: { type: 'source' | 'destination', onSelect: (it: DriveItem) => void, selectedId?: string | undefined }) {
  const [rootItems, setRootItems] = useState<DriveItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetchRoot = async () => {
      try {
        setError(false);
        const data = await apiClient(`/api/drive/${type}/root`);
        setRootItems(data.files || []);
      } catch (e) {
        console.error(e);
        setError(true);
      } finally {
        setLoading(false);
      }
    };
    fetchRoot();
  }, [type]);

  if (loading) return <div className="p-4 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-indigo-500" /></div>;
  if (error) return <div className="p-4 text-center text-red-500 font-medium border border-red-200 rounded-lg bg-red-50 dark:bg-red-900/20 dark:border-red-800">Failed to load folders</div>;
  if (rootItems.length === 0) return <div className="p-4 text-center text-gray-500 italic border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800">No folders found</div>;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-2 max-h-96 overflow-y-auto bg-white dark:bg-gray-800">
      {rootItems.map(item => (
        <TreeItem key={item.id} item={item} type={type} onSelect={onSelect} selectedId={selectedId} />
      ))}
    </div>
  );
}

export default function Migration() {
  const navigate = useNavigate();
  const [migrationType, setMigrationType] = useState<MigrationType>('DRIVE');
  const [step, setStep] = useState<Step>(1);

  // Drive Profiles
  const [sourceProfile, setSourceProfile] = useState<{state?: string; profile?: {email?: string}} | null>(null);
  const [destProfile, setDestProfile] = useState<{state?: string; profile?: {email?: string}} | null>(null);

  // Photos Profiles
  const [photosSourceProfile, setPhotosSourceProfile] = useState<{state?: string; profile?: {email?: string}} | null>(null);

  const { sessionId, sessionData, createSession, fetchSession } = useMigrationSessionStore();

  const [sourceSelectedItems, setSourceSelectedItems] = useState<DriveItem[]>([]);
  const [destSelected, setDestSelected] = useState<DriveItem | null>(null);

  // Photos Selection & Folder Target State
  const [pickerModalOpen, setPickerModalOpen] = useState(false);
  const [photosSelection, setPhotosSelection] = useState<PhotosSelectionSummary | null>(null);
  const [photosDriveFolderModalOpen, setPhotosDriveFolderModalOpen] = useState(false);
  const [photosDriveFolderSelected, setPhotosDriveFolderSelected] = useState<DriveItem | null>(null);
  const [organization, setOrganization] = useState<'FLAT' | 'BY_YEAR'>('FLAT');

  // Photos Options
  const [photosOptions, setPhotosOptions] = useState({
    migratePhotos: true,
    migrateVideos: true,
    verifyMedia: true
  });

  const [options, setOptions] = useState<TransferOptionsState>({
    preserveStructure: true,
    overwriteExisting: false,
    skipExisting: true,
    renameConflicts: false,
    verifyChecksums: true,
    keepOriginalDate: true,
    transferDocsAsPdf: false,
    preservePermissions: false,
    threads: 4,
    chunkSize: 10,
    skipErrors: true,
    dryRun: false
  });

  const [starting, setStarting] = useState(false);
  const [manifestId, setManifestId] = useState<string | null>(null);
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [pendingResumeJob, setPendingResumeJob] = useState<any>(null);

  const handleChoosePhotosClick = async () => {
    try {
      const authStatus = await apiClient('/api/photos/auth/status');
      if (!authStatus.pickerAuthorized) {
        toast.error('Google Photos permission is required. Redirecting to Google authorization...');
        window.location.href = `${API_URL}/auth/photos/source`;
        return;
      }
      setPickerModalOpen(true);
    } catch (_) {
      setPickerModalOpen(true);
    }
  };

  useEffect(() => {
    const initMigrationWizard = async () => {
      try {
        const searchParams = new URLSearchParams(window.location.search);
        if (searchParams.get('photosAuth') === 'success') {
          window.history.replaceState({}, document.title, window.location.pathname);
          setMigrationType('PHOTOS');
          toast.success('✓ Google Photos authorization connected!');
          setPickerModalOpen(true);
        }

        const [srcRes, destRes, pSrcRes, activeDiscovery] = await Promise.all([
          apiClient('/auth/source/profile').catch(() => ({ state: 'NOT_CONNECTED' })),
          apiClient('/auth/destination/profile').catch(() => ({ state: 'NOT_CONNECTED' })),
          apiClient('/auth/photos/source/profile').catch(() => ({ state: 'NOT_CONNECTED' })),
          apiClient('/api/discovery/active').catch(() => ({ active: false, job: null }))
        ]);

        setSourceProfile(srcRes);
        setDestProfile(destRes);
        setPhotosSourceProfile(pSrcRes);

        if (activeDiscovery && activeDiscovery.active && activeDiscovery.job) {
          setPendingResumeJob(activeDiscovery.job);
          setShowResumeModal(true);
        } else {
          setStep(1);
        }
      } catch (err) {
        console.error('[MigrationWizard] Initialization error:', err);
      }
    };
    initMigrationWizard();
  }, []);

  const handleResumeMigration = async () => {
    if (pendingResumeJob?.sessionId) {
      await fetchSession(pendingResumeJob.sessionId).catch(console.error);
      setStep(6);
    }
    setShowResumeModal(false);
  };

  const handleDiscardMigration = async () => {
    const { discardSession } = useMigrationSessionStore.getState();
    await discardSession().catch(console.error);
    setSourceSelectedItems([]);
    setDestSelected(null);
    setManifestId(null);
    setStep(1);
    setShowResumeModal(false);
    toast.success('Previous session discarded. Started fresh migration.');
  };

  const handleNext = async () => {
    if (migrationType === 'DRIVE' && step === 5) {
      try {
        await createSession({
          sourceEmail: sourceProfile?.profile?.email || '',
          destinationEmail: destProfile?.profile?.email || '',
          sourceFolderId: sourceSelectedItems[0]?.id || '',
          sourceFolderIds: sourceSelectedItems.map(i => i.id),
          destinationFolderId: destSelected?.id || ''
        });
      } catch (err) {
        toast.error('Failed to create migration session');
        return;
      }
    }
    setStep((s) => Math.min(s + 1, 6) as Step);
  };

  const handleBack = () => setStep((s) => Math.max(s - 1, 1) as Step);

  const startDriveMigration = async () => {
    setStarting(true);
    try {
      const currentManifestId = typeof sessionData?.manifestId === 'string' ? sessionData.manifestId : (typeof manifestId === 'string' ? manifestId : null);
      if (!currentManifestId) throw new Error('Manifest ID is missing. Discovery must complete first.');
      if (!sessionId) throw new Error('Session ID is missing.');
      if (sessionData?.discoveryStatus !== 'COMPLETED') throw new Error('Discovery phase is not complete.');

      const validation = await migrationApi.validateSession(sessionId);
      if (!validation.ready) {
        const rawError = Array.isArray(validation.errors) ? validation.errors[0] : validation.error;
        throw new Error(typeof rawError === 'string' ? rawError : 'Session validation failed.');
      }

      await migrationApi.startMigration({ manifestId: currentManifestId, sessionId, options });
      navigate('/migration/progress');
    } catch (err: any) {
      toast.error(err.message || 'Failed to start migration');
    } finally {
      setStarting(false);
    }
  };

  const startPhotosMigration = async () => {
    if (!photosSelection) {
      toast.error('Please choose photos and videos first.');
      return;
    }
    setStarting(true);
    try {
      const res = await apiClient('/api/photos/migrations', {
        method: 'POST',
        body: JSON.stringify({
          pickerSessionId: photosSelection.sessionId,
          destinationDriveFolderId: photosDriveFolderSelected?.id || 'root',
          destinationDriveFolderName: photosDriveFolderSelected?.name || 'My Drive',
          organization
        })
      });

      if (!res.jobId) throw new Error('Failed to create Google Photos migration job.');
      const pJobId = res.jobId;

      await apiClient(`/api/photos/migrations/${pJobId}/start`, { method: 'POST' });

      toast.success('Google Photos → Google Drive migration started!');
      navigate(`/photos/progress/${pJobId}`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to start Google Photos migration');
    } finally {
      setStarting(false);
    }
  };

  const [discoveryCompleted, setDiscoveryCompleted] = useState(false);
  const [activeDiscoveryStatus, setActiveDiscoveryStatus] = useState<string>('QUEUED');

  const handleDiscoveryComplete = useCallback((summary: { manifestId?: string }) => {
    if (summary.manifestId) setManifestId(summary.manifestId);
    setDiscoveryCompleted(true);
    setActiveDiscoveryStatus('COMPLETED');
    if (sessionId) fetchSession(sessionId).catch(console.error);
    toast.success('Discovery scan completed! Ready for migration.');
  }, [sessionId, fetchSession]);

  const handleDiscoveryError = useCallback((err: string) => {
    setDiscoveryCompleted(false);
    setActiveDiscoveryStatus('FAILED');
    toast.error(err);
  }, []);

  const isDriveSourceConnected = sourceProfile?.state === 'CONNECTED';
  const isDriveDestConnected = destProfile?.state === 'CONNECTED';
  const isPhotosSourceConnected = photosSourceProfile?.state === 'CONNECTED';

  const canProceedDrive = () => {
    if (step === 1) return isDriveSourceConnected;
    if (step === 2) return isDriveDestConnected;
    if (step === 3) return sourceSelectedItems.length > 0;
    if (step === 4) return !!destSelected;
    return true;
  };

  const isDiscoveryFinished = 
    (activeDiscoveryStatus === 'COMPLETED' || discoveryCompleted || sessionData?.discoveryStatus === 'COMPLETED') &&
    activeDiscoveryStatus !== 'SCANNING' && activeDiscoveryStatus !== 'FINALIZING' && activeDiscoveryStatus !== 'FAILED';

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="max-w-4xl mx-auto py-8 space-y-6">
      <Toaster position="top-right" />

      {/* Migration Type Selection Tabs */}
      <div className="bg-gray-100 dark:bg-gray-800 p-1.5 rounded-xl flex space-x-2 border border-gray-200 dark:border-gray-700">
        <button
          onClick={() => { setMigrationType('DRIVE'); setStep(1); }}
          className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm flex items-center justify-center transition-all ${
            migrationType === 'DRIVE'
              ? 'bg-white dark:bg-gray-900 text-indigo-600 dark:text-indigo-400 shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          <Cloud className="w-5 h-5 mr-2 text-blue-500" /> Google Drive Migration
        </button>

        <button
          onClick={() => { setMigrationType('PHOTOS'); setStep(1); }}
          className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm flex items-center justify-center transition-all ${
            migrationType === 'PHOTOS'
              ? 'bg-white dark:bg-gray-900 text-indigo-600 dark:text-indigo-400 shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          <Image className="w-5 h-5 mr-2 text-purple-500" /> Google Photos → Google Drive
        </button>
      </div>

      {migrationType === 'DRIVE' ? (
        <>
          {/* Drive Wizard Stepper */}
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Google Drive Migration Setup</h1>
            <div className="mt-4 flex items-center justify-between">
              {[1, 2, 3, 4, 5, 6].map((s) => (
                <div key={s} className="flex flex-col items-center flex-1">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${step >= s ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-500 dark:bg-gray-700'}`}>
                    {step > s ? <Check className="w-5 h-5" /> : s}
                  </div>
                  <div className="text-xs mt-2 text-gray-500 hidden sm:block">
                    {s === 1 && 'Source Acct'}
                    {s === 2 && 'Dest Acct'}
                    {s === 3 && 'Source Folder'}
                    {s === 4 && 'Dest Folder'}
                    {s === 5 && 'Options'}
                    {s === 6 && 'Summary'}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white dark:bg-gray-900 shadow rounded-lg p-6 border border-gray-200 dark:border-gray-700 min-h-[400px]">
            {step === 1 && (
              <div className="text-center py-6">
                <Cloud className="w-16 h-16 text-blue-500 mx-auto mb-4" />
                <h2 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">Connect Source Drive Account</h2>
                <p className="text-gray-500 mb-6 max-w-md mx-auto">Authorize CloudShift to access the Google Drive you want to copy files from.</p>
                {isDriveSourceConnected ? (
                  <div className="inline-flex items-center space-x-2 bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-4 py-2 rounded-full font-medium">
                    <Check className="w-5 h-5" />
                    <span>Connected as {sourceProfile?.profile?.email}</span>
                  </div>
                ) : (
                  <button onClick={() => { window.location.href = `${API_URL}/auth/source` }} className="bg-indigo-600 text-white px-6 py-2.5 rounded-lg font-semibold hover:bg-indigo-700 shadow-sm">
                    Connect Source Google Drive
                  </button>
                )}
              </div>
            )}

            {step === 2 && (
              <div className="text-center py-6">
                <HardDrive className="w-16 h-16 text-purple-500 mx-auto mb-4" />
                <h2 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">Connect Destination Drive Account</h2>
                <p className="text-gray-500 mb-6 max-w-md mx-auto">Authorize CloudShift to access the Google Drive where files will be copied to.</p>
                {isDriveDestConnected ? (
                  <div className="inline-flex items-center space-x-2 bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-4 py-2 rounded-full font-medium">
                    <Check className="w-5 h-5" />
                    <span>Connected as {destProfile?.profile?.email}</span>
                  </div>
                ) : (
                  <button onClick={() => { window.location.href = `${API_URL}/auth/destination` }} className="bg-indigo-600 text-white px-6 py-2.5 rounded-lg font-semibold hover:bg-indigo-700 shadow-sm">
                    Connect Destination Google Drive
                  </button>
                )}
              </div>
            )}

            {step === 3 && (
              <div>
                <h2 className="text-xl font-semibold mb-1 text-gray-900 dark:text-white">Choose Source Folders</h2>
                <p className="text-sm text-gray-500 mb-4">Select one or more folders from your source Google Drive to migrate.</p>
                <SourceFolderSelector selectedItems={sourceSelectedItems} onChange={setSourceSelectedItems} />
              </div>
            )}

            {step === 4 && (
              <div>
                <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">Choose Destination Folder</h2>
                <FolderTree type="destination" onSelect={setDestSelected} selectedId={destSelected?.id} />
                {destSelected && (
                  <div className="mt-4 p-3 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-800 dark:text-indigo-300 rounded-lg border border-indigo-200 dark:border-indigo-800">
                    Selected: <span className="font-semibold">{destSelected.name}</span>
                  </div>
                )}
              </div>
            )}

            {step === 5 && (
              <div>
                <h2 className="text-xl font-semibold mb-4 flex items-center text-gray-900 dark:text-white">
                  <Settings className="w-5 h-5 mr-2" /> Migration Options
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <label className="flex items-center space-x-3">
                    <input type="checkbox" checked={options.skipExisting} onChange={e => setOptions({...options, skipExisting: e.target.checked})} className="rounded text-indigo-600" />
                    <span className="text-gray-700 dark:text-gray-300">Skip duplicates</span>
                  </label>
                  <label className="flex items-center space-x-3">
                    <input type="checkbox" checked={options.overwriteExisting} onChange={e => setOptions({...options, overwriteExisting: e.target.checked})} className="rounded text-indigo-600" />
                    <span className="text-gray-700 dark:text-gray-300">Overwrite existing</span>
                  </label>
                  <label className="flex items-center space-x-3">
                    <input type="checkbox" checked={options.keepOriginalDate} onChange={e => setOptions({...options, keepOriginalDate: e.target.checked})} className="rounded text-indigo-600" />
                    <span className="text-gray-700 dark:text-gray-300">Preserve timestamps</span>
                  </label>
                </div>
              </div>
            )}

            {step === 6 && (
              <div>
                <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">Summary</h2>
                {sourceSelectedItems.length > 0 && sessionId && (
                  <DiscoveryScanner 
                    itemsParam={sourceSelectedItems.map(i => `${i.id}:folder`).join(',')}
                    sessionId={sessionId}
                    onComplete={handleDiscoveryComplete}
                    onError={handleDiscoveryError}
                    onStatusChange={setActiveDiscoveryStatus}
                  />
                )}
              </div>
            )}
          </div>

          <div className="mt-6 flex justify-between">
            <button onClick={handleBack} disabled={step === 1 || starting} className="flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back
            </button>

            {step < 6 ? (
              <button onClick={handleNext} disabled={!canProceedDrive()} className="flex items-center px-6 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 font-medium">
                Next <ChevronRight className="w-4 h-4 ml-2" />
              </button>
            ) : (
              <button onClick={startDriveMigration} disabled={starting || !destSelected || !isDiscoveryFinished} className="flex items-center px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 font-semibold shadow-sm">
                {starting ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                Start Drive Migration
              </button>
            )}
          </div>
        </>
      ) : (
        /* New Production Google Photos → Google Drive Setup */
        <div className="bg-white dark:bg-gray-900 shadow-sm rounded-2xl p-6 sm:p-8 border border-gray-200 dark:border-gray-700 space-y-8">
          <div className="border-b border-gray-100 dark:border-gray-800 pb-4">
            <h1 className="text-2xl font-extrabold text-gray-900 dark:text-white flex items-center">
              <Image className="w-7 h-7 text-purple-500 mr-3" /> Google Photos → Google Drive Migration
            </h1>
            <p className="text-sm text-gray-500 mt-1">Select media from Google Photos and safely transfer them directly to a Google Drive folder.</p>
          </div>

          {/* Section 1: SOURCE - Google Photos */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400">SOURCE</h2>
              {isPhotosSourceConnected && (
                <span className="inline-flex items-center text-xs font-semibold text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/30 px-2.5 py-0.5 rounded-full">
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Connected
                </span>
              )}
            </div>

            <div className="p-5 border border-gray-200 dark:border-gray-700 rounded-xl space-y-4 bg-gray-50/50 dark:bg-gray-800/30">
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-base font-bold text-gray-900 dark:text-white flex items-center">
                    <Image className="w-5 h-5 text-indigo-500 mr-2" /> Google Photos
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
                    {isPhotosSourceConnected ? photosSourceProfile?.profile?.email : 'Not connected'}
                  </p>
                </div>

                {!isPhotosSourceConnected ? (
                  <button
                    onClick={() => { window.location.href = `${API_URL}/auth/photos/source`; }}
                    className="px-4 py-2 bg-indigo-600 text-white font-medium text-xs rounded-lg hover:bg-indigo-700 shadow-sm"
                  >
                    Connect Google Photos
                  </button>
                ) : (
                  <button
                    onClick={handleChoosePhotosClick}
                    className="inline-flex items-center px-4 py-2.5 bg-indigo-600 text-white font-semibold text-xs rounded-lg hover:bg-indigo-700 shadow-sm transition-all"
                  >
                    <Sparkles className="w-4 h-4 mr-2" /> Choose Photos & Videos
                  </button>
                )}
              </div>

              {/* Selection Summary Box */}
              {photosSelection && (
                <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-indigo-200 dark:border-indigo-800 space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wide">Selected Media Summary</span>
                    <button
                      onClick={() => setPickerModalOpen(true)}
                      className="text-xs text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 font-semibold underline"
                    >
                      Change Selection
                    </button>
                  </div>

                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="p-2.5 bg-indigo-50/50 dark:bg-indigo-900/20 rounded-lg">
                      <p className="text-xs text-gray-500">Total Selected</p>
                      <p className="text-lg font-extrabold text-gray-900 dark:text-white">{photosSelection.selectedCount.toLocaleString()}</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">{formatBytes(photosSelection.totalBytes)}</p>
                    </div>
                    <div className="p-2.5 bg-blue-50/50 dark:bg-blue-900/20 rounded-lg">
                      <p className="text-xs text-gray-500 flex items-center justify-center">
                        <Image className="w-3 h-3 mr-1 text-blue-500" /> Photos
                      </p>
                      <p className="text-lg font-extrabold text-gray-900 dark:text-white">{photosSelection.photosCount.toLocaleString()}</p>
                    </div>
                    <div className="p-2.5 bg-purple-50/50 dark:bg-purple-900/20 rounded-lg">
                      <p className="text-xs text-gray-500 flex items-center justify-center">
                        <Video className="w-3 h-3 mr-1 text-purple-500" /> Videos
                      </p>
                      <p className="text-lg font-extrabold text-gray-900 dark:text-white">{photosSelection.videosCount.toLocaleString()}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-gray-100 dark:border-gray-800" />

          {/* Section 2: DESTINATION - Google Drive */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400">DESTINATION</h2>
              {isDriveDestConnected && (
                <span className="inline-flex items-center text-xs font-semibold text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/30 px-2.5 py-0.5 rounded-full">
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Connected
                </span>
              )}
            </div>

            <div className="p-5 border border-gray-200 dark:border-gray-700 rounded-xl space-y-4 bg-gray-50/50 dark:bg-gray-800/30">
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-base font-bold text-gray-900 dark:text-white flex items-center">
                    <HardDrive className="w-5 h-5 text-purple-500 mr-2" /> Google Drive
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
                    {isDriveDestConnected ? destProfile?.profile?.email : 'Not connected'}
                  </p>
                </div>

                {!isDriveDestConnected ? (
                  <button
                    onClick={() => { window.location.href = `${API_URL}/auth/destination`; }}
                    className="px-4 py-2 bg-indigo-600 text-white font-medium text-xs rounded-lg hover:bg-indigo-700 shadow-sm"
                  >
                    Connect Google Drive
                  </button>
                ) : (
                  <button
                    onClick={() => setPhotosDriveFolderModalOpen(!photosDriveFolderModalOpen)}
                    className="px-4 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 font-medium text-xs rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    {photosDriveFolderSelected ? 'Change Folder' : 'Select Folder'}
                  </button>
                )}
              </div>

              {/* Destination Folder Selector Box */}
              <div className="p-3.5 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <div className="flex items-center space-x-2 truncate">
                  <Folder className="w-5 h-5 text-amber-500 flex-shrink-0" />
                  <span className="text-xs font-semibold text-gray-500">Destination Folder:</span>
                  <span className="text-sm font-bold text-gray-900 dark:text-white truncate">
                    📁 {photosDriveFolderSelected ? photosDriveFolderSelected.name : 'My Drive'}
                  </span>
                </div>
              </div>

              {/* Folder Selector Tree Collapsible */}
              {photosDriveFolderModalOpen && (
                <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 space-y-3">
                  <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 flex items-center">
                    <FolderTreeIcon className="w-4 h-4 mr-1 text-indigo-500" /> Choose Destination Drive Folder
                  </p>
                  <FolderTree
                    type="destination"
                    onSelect={(folder) => {
                      setPhotosDriveFolderSelected(folder);
                      setPhotosDriveFolderModalOpen(false);
                      toast.success(`Destination folder set to: ${folder.name}`);
                    }}
                    selectedId={photosDriveFolderSelected?.id}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-gray-100 dark:border-gray-800" />

          {/* Section 3: OPTIONS */}
          <div className="space-y-4">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400">OPTIONS</h2>
            
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm font-medium text-gray-700 dark:text-gray-300">
              <label className="flex items-center space-x-3 p-3 bg-gray-50 dark:bg-gray-800/40 rounded-xl border border-gray-200 dark:border-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={photosOptions.migratePhotos}
                  onChange={e => setPhotosOptions({...photosOptions, migratePhotos: e.target.checked})}
                  className="rounded text-indigo-600 focus:ring-indigo-500 w-4 h-4"
                />
                <span className="flex items-center"><Image className="w-4 h-4 mr-1.5 text-blue-500" /> Photos</span>
              </label>

              <label className="flex items-center space-x-3 p-3 bg-gray-50 dark:bg-gray-800/40 rounded-xl border border-gray-200 dark:border-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={photosOptions.migrateVideos}
                  onChange={e => setPhotosOptions({...photosOptions, migrateVideos: e.target.checked})}
                  className="rounded text-indigo-600 focus:ring-indigo-500 w-4 h-4"
                />
                <span className="flex items-center"><Video className="w-4 h-4 mr-1.5 text-purple-500" /> Videos</span>
              </label>

              <label className="flex items-center space-x-3 p-3 bg-gray-50 dark:bg-gray-800/40 rounded-xl border border-gray-200 dark:border-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={photosOptions.verifyMedia}
                  onChange={e => setPhotosOptions({...photosOptions, verifyMedia: e.target.checked})}
                  className="rounded text-indigo-600 focus:ring-indigo-500 w-4 h-4"
                />
                <span>Verify Uploaded Files</span>
              </label>
            </div>

            {/* Organization Options */}
            <div className="space-y-2 pt-2">
              <span className="text-xs font-semibold text-gray-500">Drive Folder Organization</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className={`p-4 rounded-xl border cursor-pointer transition-all ${
                  organization === 'FLAT'
                    ? 'border-indigo-600 bg-indigo-50/50 dark:bg-indigo-900/20 text-indigo-900 dark:text-indigo-200'
                    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
                }`}>
                  <div className="flex items-center space-x-3">
                    <input
                      type="radio"
                      name="organization"
                      checked={organization === 'FLAT'}
                      onChange={() => setOrganization('FLAT')}
                      className="text-indigo-600 focus:ring-indigo-500"
                    />
                    <div>
                      <p className="text-sm font-bold">Flat Structure</p>
                      <p className="text-xs text-gray-500 mt-0.5">All files directly in destination folder</p>
                    </div>
                  </div>
                </label>

                <label className={`p-4 rounded-xl border cursor-pointer transition-all ${
                  organization === 'BY_YEAR'
                    ? 'border-indigo-600 bg-indigo-50/50 dark:bg-indigo-900/20 text-indigo-900 dark:text-indigo-200'
                    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
                }`}>
                  <div className="flex items-center space-x-3">
                    <input
                      type="radio"
                      name="organization"
                      checked={organization === 'BY_YEAR'}
                      onChange={() => setOrganization('BY_YEAR')}
                      className="text-indigo-600 focus:ring-indigo-500"
                    />
                    <div>
                      <p className="text-sm font-bold">By Year Folders</p>
                      <p className="text-xs text-gray-500 mt-0.5">Organize files into subfolders by year (e.g. 2026/)</p>
                    </div>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div className="border-t border-gray-100 dark:border-gray-800" />

          {/* Migration Review & Start Action */}
          <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-xs text-gray-500">
              {photosSelection ? (
                <span>Ready to migrate <strong className="text-gray-900 dark:text-white">{photosSelection.selectedCount.toLocaleString()} items</strong> to <strong className="text-gray-900 dark:text-white">{photosDriveFolderSelected ? photosDriveFolderSelected.name : 'My Drive'}</strong></span>
              ) : (
                <span>Select photos to begin migration</span>
              )}
            </div>

            <button
              onClick={startPhotosMigration}
              disabled={starting || !isPhotosSourceConnected || !isDriveDestConnected || !photosSelection || photosSelection.selectedCount === 0}
              className="w-full sm:w-auto flex items-center justify-center px-8 py-3 bg-indigo-600 text-white font-bold text-sm rounded-xl hover:bg-indigo-700 disabled:opacity-50 shadow-md transition-all"
            >
              {starting ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
              Start Migration
            </button>
          </div>
        </div>
      )}

      {/* Google Photos Picker Modal */}
      <PhotosPickerModal
        isOpen={pickerModalOpen}
        onClose={() => setPickerModalOpen(false)}
        onSelectionComplete={(summary) => {
          setPhotosSelection(summary);
        }}
      />

      {showResumeModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl max-w-md w-full p-6 shadow-2xl border border-gray-200 dark:border-gray-700">
            <div className="flex items-center space-x-3 text-indigo-600 mb-4">
              <RefreshCw className="w-7 h-7" />
              <h3 className="text-xl font-bold text-gray-900 dark:text-white">Unfinished Migration Found</h3>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-6">
              We detected an unfinished migration session from your previous activity. Would you like to resume where you left off or discard it and start fresh?
            </p>
            <div className="flex justify-end space-x-3">
              <button onClick={handleDiscardMigration} className="px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg border border-red-200 dark:border-red-800">
                Discard & Start Fresh
              </button>
              <button onClick={handleResumeMigration} className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm">
                Resume Migration
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
