import { useState, useEffect } from 'react';
import { API_URL } from '../config/api';
import { CheckCircle2, AlertTriangle, Loader2, File as FileIcon, FolderOpen, XCircle, ShieldCheck } from 'lucide-react';
import { MigrationLogViewer } from './MigrationLogViewer';

interface MigrationDashboardProps {
  jobId: string;
  onClose: () => void;
}

const formatBytes = (bytes: number) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatTime = (seconds: number) => {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

interface MigrationStatus {
  status: string;
  networkStatus: string;
  retryCount: number;
  percentage: number;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  totalBytes: number;
  transferredBytes: number;
  totalFolders: number;
  completedFolders: number;
  currentFile: string;
  currentFolder: string;
  lastSuccessfulFile: string;
  speedBytesPerSecond: number;
  remainingSeconds: number;
  elapsed: number;
  currentAction?: string;
  event?: string;
}

export function MigrationDashboard({ jobId, onClose }: MigrationDashboardProps) {
  const [status, setStatus] = useState<MigrationStatus>({
    status: 'queued',
    networkStatus: 'online',
    retryCount: 0,
    percentage: 0,
    totalFiles: 0,
    completedFiles: 0,
    failedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    totalFolders: 0,
    completedFolders: 0,
    currentFile: '',
    currentFolder: '',
    lastSuccessfulFile: '',
    speedBytesPerSecond: 0,
    remainingSeconds: 0,
    elapsed: 0
  });
  
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    let lastEventId = '0';
    let fallbackTimeout: any = null;

    const connectStream = async () => {
      try {
        const response = await fetch(`${API_URL}/api/migrations/${jobId}/status`, {
          headers: { 'Last-Event-Id': lastEventId },
          credentials: 'include' // Since API might be on different origin
        });

        if (!response.ok) throw new Error('Stream failed');
        if (!response.body) throw new Error('No body');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (active) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || ''; // Keep incomplete part

          for (const chunk of lines) {
             if (chunk.startsWith(':')) continue; // Heartbeat
             
             const linesInChunk = chunk.split('\n');
             let dataStr = '';
             for (const line of linesInChunk) {
                if (line.startsWith('id: ')) {
                   lastEventId = line.replace('id: ', '').trim();
                } else if (line.startsWith('data: ')) {
                   dataStr = line.substring(6);
                }
             }

             if (dataStr) {
                try {
                   const data = JSON.parse(dataStr);
                   if (data.error) {
                      console.error(data.error);
                      active = false;
                      break;
                   }
                   setStatus((prev) => ({ ...prev, ...data, networkStatus: 'online' }));
                   if (data.logs && data.logs.length > 0) {
                      setLogs(prev => {
                         const newLogs = [...prev];
                         data.logs.forEach((l: string) => { if (!newLogs.includes(l)) newLogs.push(l); });
                         return newLogs;
                      });
                   }
                   if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(data.status)) {
                      active = false;
                      break;
                   }
                } catch (e) {
                   console.error('JSON parse error', e);
                }
             }
          }
        }
      } catch (err) {
        if (!active) return;
        setStatus(prev => ({ ...prev, networkStatus: 'offline', retryCount: prev.retryCount + 1 }));
        
        // Fallback polling
        fallbackTimeout = setTimeout(() => {
           if (active) connectStream();
        }, 2000);
      }
    };

    connectStream();

    return () => {
      active = false;
      if (fallbackTimeout) clearTimeout(fallbackTimeout);
    };
  }, [jobId]);

  const handleCancel = async () => {
    try {
      await fetch(`${API_URL}/api/migrations/${jobId}/cancel`, { method: 'POST', credentials: 'include' });
    } catch { /* ignored */ }
  };

  const isTerminal = status.status === 'completed' || status.status === 'completed_with_errors' || status.status === 'failed' || status.status === 'cancelled';

  const renderPreparing = () => (
    <div className="p-12 text-center flex flex-col items-center">
       <div className="relative mb-6">
         <div className="absolute inset-0 rounded-full blur-xl bg-primary/20 animate-pulse"></div>
         <div className="bg-card border-2 border-primary/20 p-4 rounded-full relative z-10 shadow-xl">
           <FolderOpen className="w-12 h-12 text-primary animate-pulse" />
         </div>
       </div>
       <h2 className="text-3xl font-bold mb-3">Preparing Migration</h2>
       <p className="text-muted-foreground mb-6 font-medium max-w-sm">
         {status.currentAction || 'Creating destination folders...'}
       </p>
       
       <div className="w-full max-w-md bg-secondary/30 rounded-xl p-4 flex justify-between items-center border border-border shadow-inner">
          <div className="flex items-center gap-3">
             <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary">
                <FolderOpen className="w-4 h-4" />
             </div>
             <div className="text-sm font-medium text-left">
                <div className="text-muted-foreground uppercase text-[10px] tracking-wider mb-0.5">Folders Prepared</div>
                <div className="text-foreground">{status.completedFolders} <span className="opacity-50">/ {status.totalFolders || '?'}</span></div>
             </div>
          </div>
          {status.currentFolder && (
            <div className="text-xs text-muted-foreground max-w-[150px] truncate text-right">
              {status.currentFolder}
            </div>
          )}
       </div>
    </div>
  );

  const renderCopying = () => (
    <div className="p-8 space-y-8">
      {/* Progress Bar */}
      <div className="space-y-3">
        <div className="flex justify-between items-end">
          <span className="text-4xl font-light text-foreground">{Math.min(status.percentage, 100)}%</span>
          <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{formatBytes(Math.min(status.transferredBytes, status.totalBytes))} / {formatBytes(status.totalBytes)}</span>
        </div>
        <div className="h-4 w-full bg-secondary rounded-full overflow-hidden border border-border/50">
          <div 
            className={`h-full transition-all duration-500 bg-primary`}
            style={{ width: `${Math.min(status.percentage, 100)}%` }}
          />
        </div>
      </div>

      {/* Status Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className={`border border-border/50 rounded-xl p-4 ${status.networkStatus === 'offline' ? 'bg-amber-500/10 border-amber-500/30' : 'bg-muted/10'}`}>
          <div className="text-xs text-muted-foreground uppercase mb-1">Network Status</div>
          <div className="font-semibold text-foreground flex items-center gap-2">
            {status.networkStatus === 'online' ? (
              <><span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> Online</>
            ) : (
              <><span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span> Waiting...</>
            )}
          </div>
          {status.retryCount > 0 && (
            <div className="text-[10px] text-amber-500 mt-1">Recovered {status.retryCount} times</div>
          )}
        </div>
        <div className="bg-muted/10 border border-border/50 rounded-xl p-4">
          <div className="text-xs text-muted-foreground uppercase mb-1">Elapsed Time</div>
          <div className="font-semibold text-foreground">{formatTime(status.elapsed / 1000)}</div>
        </div>
        <div className="bg-muted/10 border border-border/50 rounded-xl p-4">
          <div className="text-xs text-muted-foreground uppercase mb-1">Est. Remaining</div>
          <div className="font-semibold text-foreground">{status.status === 'paused_network' ? 'Paused' : formatTime(status.remainingSeconds)}</div>
        </div>
        <div className="bg-muted/10 border border-border/50 rounded-xl p-4">
          <div className="text-xs text-muted-foreground uppercase mb-1">Transfer Speed</div>
          <div className="font-semibold text-foreground">{status.status === 'paused_network' ? '0 B/s' : `${formatBytes(status.speedBytesPerSecond)}/s`}</div>
        </div>
      </div>

      {/* Current Items Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4 border-t border-border">
        
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground uppercase font-medium">
            <FolderOpen className="w-4 h-4" /> Folders
          </div>
          <div className="text-2xl font-semibold">{status.completedFolders} <span className="text-muted-foreground text-base font-normal">/ {status.totalFolders || '?'}</span></div>
          <div className="text-xs text-muted-foreground truncate" title={status.currentFolder}>
            {status.currentFolder ? `${status.currentFolder}` : '...'}
          </div>
        </div>

        <div className="space-y-4 border-l border-border pl-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground uppercase font-medium">
            <FileIcon className="w-4 h-4" /> Files
          </div>
          <div className="text-2xl font-semibold">{Math.min(status.completedFiles, status.totalFiles)} <span className="text-muted-foreground text-base font-normal">/ {status.totalFiles || '?'}</span></div>
          <div className="text-xs text-muted-foreground truncate" title={status.currentFile}>
            {status.currentFile ? `${status.currentFile}` : '...'}
          </div>
        </div>

        <div className="space-y-4 border-l border-border pl-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground uppercase font-medium">
            <AlertTriangle className="w-4 h-4" /> Issues
          </div>
          <div className="text-2xl font-semibold text-destructive">{status.failedFiles}</div>
          <div className="text-xs text-muted-foreground">
            Failed items
          </div>
        </div>

      </div>
    </div>
  );

  const renderVerifying = () => (
    <div className="p-12 text-center flex flex-col items-center">
       <div className="relative mb-6">
         <div className="absolute inset-0 rounded-full blur-xl bg-purple-500/20 animate-pulse"></div>
         <div className="bg-card border-2 border-purple-500/20 p-4 rounded-full relative z-10 shadow-xl">
           <ShieldCheck className="w-12 h-12 text-purple-500 animate-pulse" />
         </div>
       </div>
       <h2 className="text-3xl font-bold mb-3">Verifying Migration</h2>
       <p className="text-muted-foreground mb-6 font-medium max-w-sm">
         {status.currentAction || 'Running consistency checks...'}
       </p>
    </div>
  );

  const renderTerminal = () => (
    <div className="p-12">
      <div className="flex flex-col items-center text-center mb-8">
        <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-4 ${status.status === 'completed' ? 'bg-emerald-500/20 text-emerald-500' : 'bg-destructive/20 text-destructive'}`}>
           {status.status === 'completed' ? <CheckCircle2 className="w-8 h-8" /> : <AlertTriangle className="w-8 h-8" />}
        </div>
        <h2 className="text-3xl font-bold mb-2">
           {status.status === 'completed' ? 'Migration Completed Successfully' : 'Migration Failed or Cancelled'}
        </h2>
        <p className="text-muted-foreground">
           Total time: {formatTime(status.elapsed / 1000)}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-muted/10 border border-border/50 rounded-xl p-4 text-center">
           <div className="text-xs text-muted-foreground uppercase mb-1">Total Folders</div>
           <div className="text-xl font-semibold">{status.completedFolders}</div>
        </div>
        <div className="bg-muted/10 border border-border/50 rounded-xl p-4 text-center">
           <div className="text-xs text-muted-foreground uppercase mb-1">Total Files</div>
           <div className="text-xl font-semibold">{status.completedFiles}</div>
        </div>
        <div className="bg-muted/10 border border-border/50 rounded-xl p-4 text-center">
           <div className="text-xs text-muted-foreground uppercase mb-1">Total Data</div>
           <div className="text-xl font-semibold">{formatBytes(status.transferredBytes)}</div>
        </div>
        <div className="bg-muted/10 border border-border/50 rounded-xl p-4 text-center">
           <div className="text-xs text-muted-foreground uppercase mb-1">Failed Items</div>
           <div className={`text-xl font-semibold ${status.failedFiles > 0 ? 'text-destructive' : 'text-emerald-500'}`}>{status.failedFiles}</div>
        </div>
      </div>
    </div>
  );

  const getHeaderTitle = () => {
    if (status.status === 'preparing') return 'Preparing Migration';
    if (status.status === 'copying') return 'Migration in Progress';
    if (status.status === 'verifying') return 'Verifying Data';
    if (status.status === 'completed') return 'Migration Summary';
    return `Migration ${status.status.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}`;
  };

  return (
    <div className="w-full max-w-5xl bg-card border border-border rounded-2xl shadow-xl overflow-hidden flex flex-col">
      <div className="p-6 border-b border-border bg-muted/20 flex items-center justify-between">
        <h2 className="text-xl font-bold flex items-center gap-3">
          {status.status === 'queued' && <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />}
          {status.status === 'preparing' && <FolderOpen className="w-5 h-5 text-primary animate-pulse" />}
          {status.status === 'copying' && <Loader2 className="w-5 h-5 text-primary animate-spin" />}
          {status.status === 'verifying' && <ShieldCheck className="w-5 h-5 text-purple-500 animate-pulse" />}
          {status.status === 'completed' && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
          {status.status === 'failed' && <AlertTriangle className="w-5 h-5 text-destructive" />}
          {status.status === 'cancelled' && <XCircle className="w-5 h-5 text-muted-foreground" />}
          
          {getHeaderTitle()}
        </h2>
        {isTerminal && (
           <button onClick={onClose} className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors text-sm font-medium">
             Done
           </button>
        )}
        {!isTerminal && (
           <button onClick={handleCancel} className="px-4 py-2 bg-destructive/10 text-destructive rounded hover:bg-destructive/20 transition-colors text-sm font-medium">
             Cancel Migration
           </button>
        )}
      </div>

      {status.status === 'preparing' && renderPreparing()}
      {(status.status === 'copying' || status.status === 'queued') && renderCopying()}
      {status.status === 'verifying' && renderVerifying()}
      {isTerminal && renderTerminal()}

      <MigrationLogViewer logs={logs} />
    </div>
  );
}
