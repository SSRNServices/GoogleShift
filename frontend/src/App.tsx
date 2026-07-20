import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { ArrowRight, HardDrive, CheckCircle2, AlertTriangle, FolderSearch } from 'lucide-react';
import { DriveBrowserModal } from './components/DriveBrowserModal';
import type { DriveItem } from './types/drive';
import { TransferSummary } from './components/TransferSummary';
import { TransferOptions, defaultOptions } from './components/TransferOptions';
import type { TransferOptionsState } from './types/transfer';
import { ConnectionStates } from './types/oauth';
import type { ProfileResponse } from './types/oauth';
import { migrationApi } from './api/migrationApi';
import { Toaster, toast } from 'react-hot-toast';
import { MigrationDashboard } from './components/MigrationDashboard';

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
      const res = await fetch(`http://localhost:3000/auth/${type}/profile`);
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
    window.location.href = `http://localhost:3000/auth/${type}`;
  };

  const handleDisconnect = async () => {
    await fetch(`http://localhost:3000/auth/${type}/logout`, { method: 'POST' });
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

function App() {
  const queryClient = useQueryClient();
  const sourceAuth = queryClient.getQueryData<ProfileResponse>(['auth', 'source']);
  const destAuth = queryClient.getQueryData<ProfileResponse>(['auth', 'destination']);

  const bothConnected = sourceAuth?.state === ConnectionStates.CONNECTED && destAuth?.state === ConnectionStates.CONNECTED;

  // Transfer State
  const [modalType, setModalType] = useState<'source' | 'destination' | null>(null);
  const [sourceSelection, setSourceSelection] = useState<DriveItem[]>([]);
  const [destinationFolder, setDestinationFolder] = useState<DriveItem | null>(null);
  const [transferOptions, setTransferOptions] = useState<TransferOptionsState>(defaultOptions);

  const handleSelectionComplete = (selection: DriveItem | DriveItem[]) => {
    if (modalType === 'source') {
      setSourceSelection(Array.isArray(selection) ? selection : [selection]);
    } else if (modalType === 'destination') {
      setDestinationFolder(Array.isArray(selection) ? selection[0] : selection);
    }
    setModalType(null);
  };

  const isReadyToTransfer = sourceSelection.length > 0 && destinationFolder !== null;

  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const migrationMutation = useMutation({
    mutationFn: migrationApi.startMigration,
    onSuccess: (data: any) => {
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
    if (migrationMutation.isPending) return;

    const payload = {
      sourceSelection,
      destinationFolder,
      options: transferOptions
    };

    try {
      await migrationMutation.mutateAsync(payload);
    } catch (e) {}
  };

  if (activeJobId) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-4 selection:bg-primary/20">
        <Toaster position="top-right" />
        <MigrationDashboard jobId={activeJobId} onClose={() => setActiveJobId(null)} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-4 selection:bg-primary/20">
      <Toaster position="top-right" />
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

export default App
