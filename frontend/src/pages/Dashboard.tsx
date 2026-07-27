import { useState } from 'react';
import { API_URL } from '../config/api';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { ArrowRight, HardDrive, CheckCircle2, AlertTriangle, FolderSearch } from 'lucide-react';
import { DriveBrowserModal } from '../components/DriveBrowserModal';
import type { DriveItem } from '../types/drive';
import { TransferSummary } from '../components/TransferSummary';
import { TransferOptions, defaultOptions } from '../components/TransferOptions';
import type { TransferOptionsState } from '../types/transfer';
import { ConnectionStates } from '../types/oauth';
import type { ProfileResponse } from '../types/oauth';
import { migrationApi } from '../api/migrationApi';
import { Toaster, toast } from 'react-hot-toast';
import { MigrationDashboard } from '../components/MigrationDashboard';
import { Loader2, LogOut } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Navigate } from 'react-router-dom';

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

function AccountSection({ title, type, onBrowseClick }: { title: string; type: 'source' | 'destination', onBrowseClick: () => void }) {
  const { data, isLoading } = useQuery<ProfileResponse>({
    queryKey: ['auth', type],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/auth/${type}/profile`, { credentials: 'include' });
      if (!res.ok) {
        throw new Error('Unexpected server error');
      }
      return res.json();
    },
    retry: false, // Never retry automatically, respect the ConnectionState
    refetchInterval: (query) => {
      // Only poll if we are NOT_CONNECTED (waiting for user to log in)
      // Stop polling if we have an active error state or are successfully connected
      if (query.state.data?.state === ConnectionStates.NOT_CONNECTED) {
        return 3000;
      }
      return false;
    }
  });

  const queryClient = useQueryClient();

  const handleConnect = () => {
    window.location.href = `${API_URL}/auth/${type}`;
  };

  const handleDisconnect = async () => {
    await fetch(`${API_URL}/auth/${type}/logout`, { method: 'POST', credentials: 'include' });
    queryClient.invalidateQueries({ queryKey: ['auth', type] });
  };

  if (isLoading) {
    return (
      <div className="flex-1 p-6 flex flex-col items-center justify-center min-h-[250px] border border-border rounded-xl bg-card/50">
        <div className="animate-pulse flex flex-col items-center">
          <div className="h-12 w-12 bg-muted rounded-full mb-4"></div>
          <div className="h-4 w-32 bg-muted rounded mb-2"></div>
          <div className="h-3 w-24 bg-muted rounded"></div>
        </div>
      </div>
    );
  }

  const state = data?.state || ConnectionStates.NOT_CONNECTED;

  if (state === ConnectionStates.CONNECTED && data?.profile) {
    const remaining = data.profile.storage.limit - data.profile.storage.used;
    const percentUsed = (data.profile.storage.used / data.profile.storage.limit) * 100;
    
    return (
      <div className="flex-1 p-6 border border-border rounded-xl bg-card relative overflow-hidden group transition-all hover:border-primary/50">
        <div className="absolute top-4 right-4 flex items-center gap-1.5 text-xs font-medium text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded-full">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Connected
        </div>
        
        <h3 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase mb-6">{title}</h3>
        
        <div className="flex items-center gap-4 mb-6">
          <img src={data.profile.picture} alt="Avatar" className="w-14 h-14 rounded-full ring-2 ring-border" referrerPolicy="no-referrer" />
          <div>
            <h4 className="font-semibold text-lg text-foreground">{data.profile.name}</h4>
            <p className="text-sm text-muted-foreground">{data.profile.email}</p>
          </div>
        </div>

        <div className="space-y-3 mb-6">
          <div className="flex justify-between text-sm">
            <span className="flex items-center gap-2 text-muted-foreground"><HardDrive className="w-4 h-4" /> Storage Used</span>
            <span className="font-medium text-foreground">{formatBytes(data.profile.storage.used)} / {formatBytes(data.profile.storage.limit)}</span>
          </div>
          <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
            <div 
              className="h-full bg-primary transition-all duration-1000" 
              style={{ width: `${Math.min(100, Math.max(0, percentUsed))}%` }}
            />
          </div>
          <div className="text-right text-xs text-muted-foreground">
            {formatBytes(remaining)} remaining
          </div>
        </div>

        <div className="flex gap-3">
          <button 
            onClick={onBrowseClick}
            className="flex-1 bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 py-2.5 rounded-md flex items-center justify-center gap-2 transition-colors"
          >
            <FolderSearch className="w-4 h-4" />
            Browse Drive
          </button>
          <button 
            onClick={handleDisconnect}
            className="px-4 text-sm font-medium text-destructive hover:bg-destructive/10 py-2.5 rounded-md transition-colors"
            title="Disconnect Account"
          >
            Disconnect
          </button>
        </div>
      </div>
    );
  }

  if (state === ConnectionStates.TOKEN_EXPIRED || state === ConnectionStates.TOKEN_REVOKED) {
    return (
      <div className="flex-1 p-6 border border-destructive/50 rounded-xl bg-destructive/5 flex flex-col items-center justify-center min-h-[250px] transition-colors">
        <div className="flex items-center gap-2 text-destructive mb-4">
          <AlertTriangle className="w-5 h-5" />
          <span className="font-semibold">
            {state === ConnectionStates.TOKEN_EXPIRED ? 'Session Expired' : 'Access Revoked'}
          </span>
        </div>
        <h3 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase mb-4">{title}</h3>
        <button 
          onClick={handleConnect}
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90 font-medium px-6 py-2.5 rounded-md shadow-sm transition-all active:scale-95"
        >
          Reconnect Account
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 p-6 border border-dashed border-border rounded-xl bg-card/30 flex flex-col items-center justify-center min-h-[250px] transition-colors hover:bg-card/50">
      <h3 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase mb-4">{title}</h3>
      <button 
        onClick={handleConnect}
        className="bg-foreground text-background hover:bg-foreground/90 font-medium px-6 py-2.5 rounded-md flex items-center gap-2 shadow-sm transition-all active:scale-95"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5 bg-background text-foreground rounded-full p-0.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
           <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" />
           <path d="M15 12H9" />
           <path d="M12 9L12 15" />
        </svg>
        Connect Account
      </button>
    </div>
  );
}

export default function Dashboard() {
  const { isAuthenticated, user, logout, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const sourceAuth = queryClient.getQueryData<ProfileResponse>(['auth', 'source']);
  const destAuth = queryClient.getQueryData<ProfileResponse>(['auth', 'destination']);

  const bothConnected = sourceAuth?.state === ConnectionStates.CONNECTED && destAuth?.state === ConnectionStates.CONNECTED;

  // Transfer State
  const [modalType, setModalType] = useState<'source' | 'destination' | null>(null);
  const [sourceSelection, setSourceSelection] = useState<DriveItem[]>([]);
  const [destinationFolder, setDestinationFolder] = useState<DriveItem | null>(null);
  const [transferOptions, setTransferOptions] = useState<TransferOptionsState>(defaultOptions);
  const [manifestId, setManifestId] = useState<string | null>(null);

  const handleSelectionComplete = (selection: DriveItem | DriveItem[]) => {
    if (modalType === 'source') {
      setSourceSelection(Array.isArray(selection) ? selection : [selection]);
      setManifestId(null);
    } else if (modalType === 'destination') {
      setDestinationFolder(Array.isArray(selection) ? selection[0] : selection);
    }
    setModalType(null);
  };

  const isReadyToTransfer = sourceSelection.length > 0 && destinationFolder !== null && manifestId !== null;

  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  // Check current job on mount
  const { data: currentJob, isLoading: isLoadingCurrent } = useQuery({
    queryKey: ['migration', 'current'],
    queryFn: migrationApi.getCurrent,
    retry: false,
    refetchOnWindowFocus: false
  });

  const resumeMutation = useMutation({
    mutationFn: migrationApi.resume,
    onSuccess: (_data: unknown, variables: string) => {
      setActiveJobId(variables);
    },
    onError: (e) => toast.error('Failed to resume migration: ' + e.message)
  });

  const discardMutation = useMutation({
    mutationFn: migrationApi.discard,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['migration', 'current'] });
    },
    onError: (e) => toast.error('Failed to discard migration: ' + e.message)
  });

  const currentJobStatus = currentJob?.status || '';
  if (['running', 'creating_tree', 'uploading_files', 'verifying'].includes(currentJobStatus) && !activeJobId) {
    setActiveJobId(currentJob?.jobId || null);
  }

  const migrationMutation = useMutation({
    mutationFn: migrationApi.startMigration,
    onSuccess: (data: { jobId: string }) => {
      console.log('Migration started successfully:', data);
      toast.success('Migration job initialized successfully!');
      if (data.jobId) {
         setActiveJobId(data.jobId);
      }
    },
    onError: (error: Error) => {
      console.error('Migration failed to start:', error);
      toast.error(error.message || 'Failed to start migration');
    }
  });

  const handleStartMigration = async () => {
    if (!bothConnected) {
      toast.error('Both accounts must be connected');
      return;
    }
    if (sourceSelection.length === 0) {
      toast.error('Please select at least one item to migrate');
      return;
    }
    if (!destinationFolder) {
      toast.error('Please select a destination folder');
      return;
    }
    if (!manifestId) {
      toast.error('Please wait for the summary scan to complete');
      return;
    }
    if (migrationMutation.isPending) return;

    const payload = {
      manifestId,
      sourceSelection,
      destinationFolderId: destinationFolder.id,
      options: transferOptions
    };

    try {
      await migrationMutation.mutateAsync(payload);
    } catch {
      // Error handled by onError in mutation
    }
  };

  if (activeJobId) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-4 selection:bg-primary/20">
        <Toaster position="top-right" />
        <MigrationDashboard jobId={activeJobId} onClose={() => setActiveJobId(null)} />
      </div>
    );
  }

  if (authLoading || isLoadingCurrent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  if (currentJobStatus === 'paused' && !activeJobId) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-4">
        <Toaster position="top-right" />
        <div className="w-full max-w-md bg-card border border-border rounded-2xl shadow-xl overflow-hidden p-8 flex flex-col gap-6 text-center">
          <div className="w-16 h-16 bg-amber-500/20 rounded-full flex items-center justify-center mx-auto">
            <AlertTriangle className="text-amber-500 w-8 h-8" />
          </div>
          <div>
            <h2 className="text-2xl font-bold mb-2">Interrupted Migration</h2>
            <p className="text-muted-foreground text-sm">
              We detected an unfinished migration that was paused. You can resume exactly where it left off, or discard it to start a new one.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <button 
              onClick={() => resumeMutation.mutate(currentJob?.jobId as string)}
              disabled={resumeMutation.isPending || discardMutation.isPending}
              className="bg-primary text-primary-foreground font-semibold px-6 py-3 rounded-lg shadow-sm hover:bg-primary/90 transition-all flex items-center justify-center gap-2"
            >
              {resumeMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Resume Previous Migration
            </button>
            <button 
              onClick={() => discardMutation.mutate(currentJob?.jobId as string)}
              disabled={resumeMutation.isPending || discardMutation.isPending}
              className="bg-destructive/10 text-destructive font-semibold px-6 py-3 rounded-lg hover:bg-destructive/20 transition-all flex items-center justify-center gap-2"
            >
              {discardMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Discard Previous Migration
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center p-4 selection:bg-primary/20 pb-16">
      <Toaster position="top-right" />
      
      {/* Top Profile Header */}
      <div className="w-full max-w-5xl flex justify-end items-center mb-8 gap-4">
        {user && (
          <div className="flex items-center gap-3 bg-card border border-border px-4 py-2 rounded-full shadow-sm">
            <img src={user.picture} alt="Profile" className="w-8 h-8 rounded-full ring-1 ring-border" referrerPolicy="no-referrer" />
            <div className="flex flex-col">
              <span className="text-sm font-semibold leading-tight">{user.name}</span>
              <span className="text-xs text-muted-foreground leading-tight">{user.email}</span>
            </div>
          </div>
        )}
        <button 
          onClick={logout}
          className="flex items-center gap-2 px-4 py-2 bg-secondary text-secondary-foreground text-sm font-medium rounded-full hover:bg-secondary/80 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Logout
        </button>
      </div>

      <div className="w-full max-w-4xl flex flex-col items-center mb-10 text-center">
        <div className="w-16 h-16 bg-primary rounded-2xl rotate-3 shadow-lg flex items-center justify-center mb-6">
          <ArrowRight className="text-primary-foreground w-8 h-8 -rotate-3" />
        </div>
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-3 bg-clip-text text-transparent bg-gradient-to-br from-foreground to-foreground/60">
          CloudShift
        </h1>
        <p className="text-lg text-muted-foreground max-w-lg">
          Move Google data directly between accounts without downloading to your computer.
        </p>
      </div>

      <div className="w-full max-w-4xl bg-card border border-border rounded-2xl shadow-xl overflow-hidden p-8 flex flex-col gap-8">
        
        <div className="flex flex-col md:flex-row gap-6">
          <AccountSection title="Source Account" type="source" onBrowseClick={() => setModalType('source')} />
          <div className="flex items-center justify-center">
            <ArrowRight className="w-6 h-6 text-muted-foreground hidden md:block opacity-50" />
          </div>
          <AccountSection title="Destination Account" type="destination" onBrowseClick={() => setModalType('destination')} />
        </div>

        {bothConnected && (
          <div className="space-y-6 pt-6 border-t border-border">
            <TransferSummary 
              sourceSelection={sourceSelection}
              destinationFolder={destinationFolder}
              onScanComplete={(id) => setManifestId(id)}
            />
            <TransferOptions 
              options={transferOptions}
              onChange={setTransferOptions}
            />
          </div>
        )}

        <div className="pt-4 border-t border-border flex justify-end">
          <button 
            disabled={!isReadyToTransfer || migrationMutation.isPending}
            onClick={handleStartMigration}
            className="bg-primary text-primary-foreground font-semibold px-8 py-3 rounded-lg shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary/90 active:scale-95 flex items-center gap-2"
          >
            {migrationMutation.isPending ? 'Starting...' : 'Start Migration'}
            <ArrowRight className="w-5 h-5" />
          </button>
        </div>

      </div>

      <DriveBrowserModal 
        isOpen={modalType !== null}
        onClose={() => setModalType(null)}
        type={modalType || 'source'}
        onSelectionComplete={handleSelectionComplete}
      />
    </div>
  )
}
