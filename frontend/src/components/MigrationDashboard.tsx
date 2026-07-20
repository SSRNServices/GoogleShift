import { useState, useEffect } from 'react';
import { ArrowRight, CheckCircle2, AlertTriangle, Loader2, HardDrive, File as FileIcon, FolderOpen, Play, Pause, XCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
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

export function MigrationDashboard({ jobId, onClose }: MigrationDashboardProps) {
  const [status, setStatus] = useState<any>({
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
    const eventSource = new EventSource(`http://localhost:3000/api/migrations/${jobId}/status`);
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.error) {
           console.error(data.error);
           eventSource.close();
           return;
        }
        
        setStatus((prev: any) => ({ ...prev, ...data }));
        if (data.logs && data.logs.length > 0) {
           setLogs(prev => [...prev, ...data.logs]);
        }
        
        if (data.status === 'completed' || data.status === 'completed_with_errors' || data.status === 'failed' || data.status === 'cancelled') {
           eventSource.close();
        }
      } catch (err) {}
    };

    return () => {
      eventSource.close();
    };
  }, [jobId]);

  const handleCancel = async () => {
    try {
      await fetch(`http://localhost:3000/api/migrations/${jobId}/cancel`, { method: 'POST' });
    } catch (err) {}
  };

  const isTerminal = status.status === 'completed' || status.status === 'completed_with_errors' || status.status === 'failed' || status.status === 'cancelled';

  return (
    <div className="w-full max-w-5xl bg-card border border-border rounded-2xl shadow-xl overflow-hidden flex flex-col">
      <div className="p-6 border-b border-border bg-muted/20 flex items-center justify-between">
        <h2 className="text-xl font-bold flex items-center gap-3">
          {status.status === 'running' && <Loader2 className="w-5 h-5 text-primary animate-spin" />}
          {status.status === 'creating_tree' && <FolderOpen className="w-5 h-5 text-primary animate-pulse" />}
          {status.status === 'uploading_files' && <Loader2 className="w-5 h-5 text-primary animate-spin" />}
          {status.status === 'verifying' && <CheckCircle2 className="w-5 h-5 text-primary animate-pulse" />}
          {status.status === 'paused_network' && <Loader2 className="w-5 h-5 text-amber-500 animate-spin" />}
          {status.status === 'completed' && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
          {status.status === 'completed_with_errors' && <AlertTriangle className="w-5 h-5 text-amber-500" />}
          {status.status === 'failed' && <AlertTriangle className="w-5 h-5 text-destructive" />}
          {status.status === 'cancelled' && <XCircle className="w-5 h-5 text-muted-foreground" />}
          {status.status === 'queued' && <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />}
          
          {status.status === 'paused_network' 
            ? `Paused (Network Issue) - Retrying` 
            : `Migration ${status.status.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}`}
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

      <div className="p-8 space-y-8">
        
        {/* Progress Bar */}
        <div className="space-y-3">
          <div className="flex justify-between items-end">
            <span className="text-4xl font-light text-foreground">{status.percentage}%</span>
            <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{formatBytes(status.transferredBytes)} / {formatBytes(status.totalBytes)}</span>
          </div>
          <div className="h-4 w-full bg-secondary rounded-full overflow-hidden border border-border/50">
            <div 
              className={`h-full transition-all duration-500 ${status.status === 'failed' ? 'bg-destructive' : status.status === 'completed' ? 'bg-emerald-500' : 'bg-primary'}`}
              style={{ width: `${status.percentage}%` }}
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
            <div className="text-2xl font-semibold">{status.completedFiles} <span className="text-muted-foreground text-base font-normal">/ {status.totalFiles || '?'}</span></div>
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

      <MigrationLogViewer logs={logs} />
    </div>
  );
}
