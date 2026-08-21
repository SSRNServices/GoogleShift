import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/apiClient';
import { API_URL } from '../config/api';
import { Check, ChevronRight, Folder, Loader2, ArrowLeft, Cloud, HardDrive, Settings, Play, RefreshCw } from 'lucide-react';
import { migrationApi } from '../api/migrationApi';
import { DiscoveryScanner } from '../components/DiscoveryScanner';
import { SourceFolderSelector } from '../components/SourceFolderSelector';
import { useMigrationSessionStore } from '../store/useMigrationSessionStore';
import type { TransferOptionsState } from '../types/transfer';
import type { DriveItem } from '../types/drive';
import { Toaster, toast } from 'react-hot-toast';

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
        className={`flex items-center py-1 px-2 rounded cursor-pointer transition-colors ${isSelected ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300' : 'hover:bg-gray-100 dark:hover:bg-gray-800'}`}
        onClick={() => { if(isFolder) onSelect(item); }}
      >
        <div onClick={handleExpand} className="mr-1 cursor-pointer p-0.5">
          {isFolder ? (
            loading ? <Loader2 className="w-3 h-3 animate-spin" /> : 
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
  const [step, setStep] = useState<Step>(1);
  const [sourceProfile, setSourceProfile] = useState<{state?: string; profile?: {email?: string}} | null>(null);
  const [destProfile, setDestProfile] = useState<{state?: string; profile?: {email?: string}} | null>(null);
  
  const { sessionId, sessionData, createSession, fetchSession } = useMigrationSessionStore();

  const [sourceSelectedItems, setSourceSelectedItems] = useState<DriveItem[]>([]);
  const [destSelected, setDestSelected] = useState<DriveItem | null>(null);
  
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

  useEffect(() => {
    const initMigrationWizard = async () => {
      try {
        const [srcRes, destRes, activeDiscovery] = await Promise.all([
          apiClient('/auth/source/profile').catch(() => ({ state: 'NOT_CONNECTED' })),
          apiClient('/auth/destination/profile').catch(() => ({ state: 'NOT_CONNECTED' })),
          apiClient('/api/discovery/active').catch(() => ({ active: false, job: null }))
        ]);

        setSourceProfile(srcRes);
        setDestProfile(destRes);

        if (activeDiscovery && activeDiscovery.active && activeDiscovery.job) {
          console.log('[MigrationWizard] Active discovery session detected on mount:', activeDiscovery.job);
          setPendingResumeJob(activeDiscovery.job);
          setShowResumeModal(true);
        } else {
          // Default to fresh Step 1
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
      console.log('[MigrationWizard] User chose to RESUME session:', pendingResumeJob.sessionId);
      await fetchSession(pendingResumeJob.sessionId).catch(console.error);
      setStep(6);
    }
    setShowResumeModal(false);
  };

  const handleDiscardMigration = async () => {
    console.log('[MigrationWizard] User chose to DISCARD previous session.');
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
    // When moving to summary (step 5 to 6), ALWAYS create a brand-new session for current folder selections
    if (step === 5) {
      try {
        console.log('[Frontend Wizard] Creating new MigrationSession for source folders:', sourceSelectedItems.map(i => i.name));
        await createSession({
          sourceEmail: sourceProfile?.profile?.email || '',
          destinationEmail: destProfile?.profile?.email || '',
          sourceFolderId: sourceSelectedItems[0]?.id || '',
          sourceFolderIds: sourceSelectedItems.map(i => i.id),
          destinationFolderId: destSelected?.id || ''
        });
      } catch (err) {
        console.error('[Frontend Wizard] Session creation error:', err);
        toast.error('Failed to create migration session');
        return;
      }
    }
    setStep((s) => Math.min(s + 1, 6) as Step);
  };
  
  const handleBack = () => setStep((s) => Math.max(s - 1, 1) as Step);

  const startMigration = async () => {
    setStarting(true);
    try {
      const currentManifestId = typeof sessionData?.manifestId === 'string' ? sessionData.manifestId : (typeof manifestId === 'string' ? manifestId : null);
      if (!currentManifestId) throw new Error('Manifest ID is missing. Discovery must complete first.');
      if (!sessionId) throw new Error('Session ID is missing.');
      if (sessionData?.discoveryStatus !== 'COMPLETED') throw new Error('Discovery phase is not complete.');

      // Backend pre-flight validation
      const validation = await migrationApi.validateSession(sessionId);
      if (!validation.ready) {
        const rawError = Array.isArray(validation.errors) ? validation.errors[0] : validation.error;
        const errorMsg = typeof rawError === 'string' ? rawError : 'Session validation failed. Please check account connections.';
        throw new Error(errorMsg);
      }

      await migrationApi.startMigration({
        manifestId: currentManifestId,
        sessionId,
        options
      });
      navigate('/migration/progress');
    } catch (err: unknown) {
      if (err instanceof Error) {
        toast.error(err.message || 'Failed to start migration');
      } else {
        toast.error('Failed to start migration');
      }
    } finally {
      setStarting(false);
    }
  };

  const handleDiscoveryComplete = useCallback((summary: { manifestId?: string; totalFolders?: number; totalFiles?: number; totalBytes?: number }) => {
    console.log('[MigrationWizard] handleDiscoveryComplete invoked with summary:', summary);
    if (summary.manifestId) {
      setManifestId(summary.manifestId);
    }
    if (sessionId) {
      fetchSession(sessionId).catch(console.error);
    }
    toast.success('Discovery scan completed! Ready for migration.');
  }, [sessionId, fetchSession]);

  const handleDiscoveryError = useCallback((err: string) => {
    toast.error(err);
  }, []);

  const isSourceConnected = sourceProfile?.state === 'CONNECTED';
  const isDestConnected = destProfile?.state === 'CONNECTED';

  const canProceed = () => {
    if (step === 1) return isSourceConnected;
    if (step === 2) return isDestConnected;
    if (step === 3) return sourceSelectedItems.length > 0;
    if (step === 4) return !!destSelected;
    return true;
  };

  const isDiscoveryFinished = sessionData?.discoveryStatus === 'COMPLETED' || !!manifestId || !!sessionData?.manifestId;

  return (
    <div className="max-w-4xl mx-auto py-8">
      <Toaster position="top-right" />
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Migration Setup</h1>
        
        {/* Stepper */}
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
          <div className="text-center">
            <Cloud className="w-16 h-16 text-blue-500 mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">Connect Source Account</h2>
            <p className="text-gray-500 mb-6">Authorize CloudShift to access the Google Drive you want to copy files from.</p>
            {isSourceConnected ? (
              <div className="inline-flex items-center space-x-2 bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-4 py-2 rounded-full font-medium">
                <Check className="w-5 h-5" />
                <span>Connected as {sourceProfile.profile?.email}</span>
              </div>
            ) : (
              <button 
                onClick={() => { window.location.href = `${API_URL}/auth/source` }} 
                className="bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700"
              >
                Connect Source Google Drive
              </button>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="text-center">
            <HardDrive className="w-16 h-16 text-purple-500 mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">Connect Destination Account</h2>
            <p className="text-gray-500 mb-6">Authorize CloudShift to access the Google Drive where files will be copied to.</p>
            {isDestConnected ? (
              <div className="inline-flex items-center space-x-2 bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-4 py-2 rounded-full font-medium">
                <Check className="w-5 h-5" />
                <span>Connected as {destProfile.profile?.email}</span>
              </div>
            ) : (
              <button 
                onClick={() => { window.location.href = `${API_URL}/auth/destination` }} 
                className="bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700"
              >
                Connect Destination Google Drive
              </button>
            )}
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="text-xl font-semibold mb-1 text-gray-900 dark:text-white">Choose Source Folders</h2>
            <p className="text-sm text-gray-500 mb-4">Select one or more folders from your source Google Drive to migrate.</p>
            <SourceFolderSelector 
              selectedItems={sourceSelectedItems} 
              onChange={setSourceSelectedItems} 
            />
          </div>
        )}

        {step === 4 && (
          <div>
            <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">Choose Destination Folder</h2>
            <FolderTree type="destination" onSelect={setDestSelected} selectedId={destSelected?.id} />
            {destSelected && (
              <div className="mt-4 p-3 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-800 dark:text-indigo-300 rounded border border-indigo-200 dark:border-indigo-800">
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
              />
            )}
          </div>
        )}
      </div>

      <div className="mt-6 flex justify-between">
        <button
          onClick={handleBack}
          disabled={step === 1 || starting}
          className="flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
        >
          <ArrowLeft className="w-4 h-4 mr-2" /> Back
        </button>

        {step < 6 ? (
          <button
            onClick={handleNext}
            disabled={!canProceed()}
            className="flex items-center px-6 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            Next <ChevronRight className="w-4 h-4 ml-2" />
          </button>
        ) : (
          <button
            onClick={startMigration}
            disabled={starting || !destSelected || !isDiscoveryFinished}
            className="flex items-center px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
            title={!isDiscoveryFinished ? 'Run Discovery first.' : ''}
          >
            {starting ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
            Start Migration
          </button>
        )}
      </div>

      {showResumeModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl max-w-md w-full p-6 shadow-2xl border border-gray-200 dark:border-gray-700 animate-in fade-in zoom-in duration-200">
            <div className="flex items-center space-x-3 text-indigo-600 mb-4">
              <RefreshCw className="w-7 h-7" />
              <h3 className="text-xl font-bold text-gray-900 dark:text-white">Unfinished Migration Found</h3>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-6 leading-relaxed">
              We detected an unfinished migration session from your previous activity. Would you like to resume where you left off or discard it and start fresh?
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={handleDiscardMigration}
                className="px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors border border-red-200 dark:border-red-800"
              >
                Discard & Start Fresh
              </button>
              <button
                onClick={handleResumeMigration}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm transition-colors"
              >
                Resume Migration
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
