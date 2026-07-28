import { useState, useEffect } from 'react';
import { API_URL } from '../config/api';
import { HardDrive, FolderOpen, File as FileIcon, Loader2, AlertCircle, FileText, AlertTriangle } from 'lucide-react';
import type { DriveItem } from '../types/drive';
import type { ScanSummaryResult, StorageStats, MimeBreakdown, ScanWarningInfo } from '../types/drive';

export interface TransferSummaryProps {
  sessionId: string;
  sourceSelection: DriveItem[];
  destinationFolder: DriveItem | null;
  onScanComplete?: (manifestId: string, stats: ScanSummaryResult) => void;
}

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export function TransferSummary({ sessionId, sourceSelection, onScanComplete }: TransferSummaryProps) {
  const [scanState, setScanState] = useState<'Idle' | 'Scanning' | 'Completed' | 'Failed'>('Idle');
  const [currentAction, setCurrentAction] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [stats, setStats] = useState<ScanSummaryResult>({
    scanStatus: 'Idle',
    totalFolders: 0,
    totalFiles: 0,
    totalBytes: 0,
    largestFile: 0,
  });

  const [currentFolder, setCurrentFolder] = useState<string>('');
  const [currentFile, setCurrentFile] = useState<string>('');
  const [startTime, setStartTime] = useState<number>(0);
  const [elapsedTime, setElapsedTime] = useState<number>(0);

  useEffect(() => {
    let timer: number;
    if (scanState === 'Scanning') {
      timer = window.setInterval(() => {
        setElapsedTime(Date.now() - startTime);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [scanState, startTime]);

  useEffect(() => {
    if (sourceSelection.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setScanState('Idle');
      return;
    }

    setScanState('Scanning');
    setErrorMsg(null);
    setCurrentAction('Connecting to discovery stream...');
    setStartTime(Date.now());
    setElapsedTime(0);

    const url = `${API_URL}/api/discovery/${sessionId}/status`;
    const eventSource = new EventSource(url, { withCredentials: true });

    eventSource.onopen = () => {
      console.log('[Frontend] Discovery SSE connection opened.');
      setCurrentAction('Initializing scan...');
    };

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'connected') return;

        const { event: eventName, data } = payload;

        if (eventName === 'ERROR') {
          setScanState('Failed');
          setErrorMsg(data?.message || 'Unknown error occurred');
          eventSource.close();
          return;
        }

        if (eventName === 'SCAN_STARTED' || eventName === 'MANIFEST_UPDATED') {
          setCurrentAction(data.message);
        }

        if (eventName === 'SCAN_FOLDER') {
          setCurrentFolder(data.folderName);
          setStats(prev => ({ ...prev, totalFolders: data.totalFolders }));
        }

        if (eventName === 'SCAN_PROGRESS') {
          setCurrentFile(data.currentFile);
          setStats(prev => ({ 
             ...prev, 
             totalFiles: data.totalFiles,
             totalBytes: data.totalBytes
          }));
        }

        if (eventName === 'SCAN_COMPLETED') {
          setScanState('Completed');
          setCurrentAction('Discovery complete');
          setStats(data);
          if (onScanComplete && data.manifestId) {
             onScanComplete(data.manifestId, data as ScanSummaryResult);
          }
          eventSource.close();
        }

        if (eventName === 'CLOSE') {
          eventSource.close();
        }

      } catch (err) {
        console.error('Error parsing SSE data', err);
      }
    };

    eventSource.onerror = (err) => {
      console.error('SSE Error:', err);
      if (scanState !== 'Completed') {
         setScanState('Failed');
         setErrorMsg('Connection to discovery stream lost.');
      }
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSelection]);

  const formatDuration = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const renderScanning = () => (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="relative mb-8">
        <div className="absolute inset-0 rounded-full blur-xl bg-primary/20 animate-pulse"></div>
        <div className="bg-card border-2 border-primary/20 p-4 rounded-full relative z-10 shadow-xl">
           <Loader2 className="w-10 h-10 text-primary animate-spin" />
        </div>
      </div>
      <h3 className="text-xl font-bold text-foreground tracking-tight mb-2">Scanning Google Drive</h3>
      <p className="text-muted-foreground font-medium mb-8 text-center max-w-sm">
        {currentAction || 'Discovering items...'}
      </p>

      <div className="w-full max-w-md bg-secondary/50 rounded-xl p-6 border border-border shadow-sm">
        <div className="space-y-4">
          <div className="flex justify-between items-center text-sm">
            <span className="text-muted-foreground flex items-center gap-2"><FolderOpen className="w-4 h-4" /> Folders discovered</span>
            <span className="font-semibold text-foreground">{stats.totalFolders.toLocaleString()}</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-muted-foreground flex items-center gap-2"><FileIcon className="w-4 h-4" /> Files discovered</span>
            <span className="font-semibold text-foreground">{stats.totalFiles.toLocaleString()}</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-muted-foreground flex items-center gap-2"><HardDrive className="w-4 h-4" /> Data found</span>
            <span className="font-semibold text-foreground">{formatBytes(stats.totalBytes)}</span>
          </div>
          <div className="pt-4 mt-4 border-t border-border flex justify-between items-center text-sm">
             <span className="text-muted-foreground">Elapsed time</span>
             <span className="font-mono text-foreground">{formatDuration(elapsedTime)}</span>
          </div>
          {currentFolder && (
            <div className="text-xs text-muted-foreground truncate mt-2">
               Dir: {currentFolder}
            </div>
          )}
          {currentFile && (
            <div className="text-xs text-muted-foreground truncate">
               File: {currentFile}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderStorageAnalysis = (analysis: StorageStats) => {
     const percentUsed = (analysis.used / analysis.limit) * 100;
     const percentIncoming = (stats.totalBytes / analysis.limit) * 100;

     return (
       <div className="bg-card rounded-xl p-6 border border-border shadow-sm mb-6">
         <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">Destination Storage Analysis</h4>
         <div className="space-y-4">
           <div className="flex justify-between text-sm">
             <span className="font-medium text-foreground">Required: {formatBytes(stats.totalBytes)}</span>
             <span className="text-muted-foreground">Free: {formatBytes(analysis.remaining)}</span>
           </div>
           
           <div className="h-4 w-full bg-secondary rounded-full overflow-hidden flex">
             <div 
               className="h-full bg-gray-500/50 transition-all duration-1000" 
               style={{ width: `${Math.min(100, Math.max(0, percentUsed))}%` }}
               title={`Already Used: ${formatBytes(analysis.used)}`}
             />
             <div 
               className={`h-full ${analysis.sufficient ? 'bg-primary' : 'bg-destructive'} transition-all duration-1000`} 
               style={{ width: `${Math.min(100 - percentUsed, Math.max(0, percentIncoming))}%` }}
               title={`Incoming: ${formatBytes(stats.totalBytes)}`}
             />
           </div>

           {!analysis.sufficient && (
              <div className="flex items-start gap-2 text-destructive bg-destructive/10 p-3 rounded-md text-sm mt-2 border border-destructive/20">
                 <AlertCircle className="w-5 h-5 shrink-0" />
                 <p className="font-medium">Insufficient storage in destination account. You need {formatBytes(stats.totalBytes - analysis.remaining)} more space.</p>
              </div>
           )}
           {analysis.estimatedTimeSeconds > 0 && (
              <div className="text-sm text-muted-foreground mt-2 flex justify-between">
                 <span>Estimated Copy Time:</span>
                 <span className="font-semibold text-foreground">~{formatDuration(analysis.estimatedTimeSeconds * 1000)}</span>
              </div>
           )}
         </div>
       </div>
     );
  };

  const renderMimeBreakdown = (mime: MimeBreakdown) => {
    const total = stats.totalFiles || 1;
    const segments = [
      { key: 'Docs', val: mime.googleDocs, color: 'bg-blue-500' },
      { key: 'Sheets', val: mime.googleSheets, color: 'bg-green-500' },
      { key: 'Slides', val: mime.googleSlides, color: 'bg-yellow-500' },
      { key: 'PDFs', val: mime.pdf, color: 'bg-red-500' },
      { key: 'Images', val: mime.images, color: 'bg-purple-500' },
      { key: 'Videos', val: mime.videos, color: 'bg-pink-500' },
      { key: 'Archives', val: mime.archives, color: 'bg-orange-500' },
      { key: 'Other', val: mime.other + mime.unsupported, color: 'bg-gray-400' },
    ].filter(s => s.val > 0).sort((a, b) => b.val - a.val);

    return (
      <div className="bg-card rounded-xl p-6 border border-border shadow-sm mb-6">
        <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">File Type Breakdown</h4>
        <div className="h-6 w-full bg-secondary rounded-full overflow-hidden flex mb-6 shadow-inner">
          {segments.map(seg => (
            <div 
              key={seg.key}
              className={`h-full ${seg.color}`}
              style={{ width: `${(seg.val / total) * 100}%` }}
              title={`${seg.key}: ${seg.val}`}
            />
          ))}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {segments.map(seg => (
             <div key={seg.key} className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${seg.color}`}></div>
                <div className="text-sm">
                   <div className="font-medium text-foreground">{seg.val.toLocaleString()}</div>
                   <div className="text-xs text-muted-foreground">{seg.key}</div>
                </div>
             </div>
          ))}
        </div>
      </div>
    );
  };

  const renderWarnings = (warnings: ScanWarningInfo[]) => {
    if (!warnings || warnings.length === 0) return null;
    return (
       <div className="bg-card rounded-xl p-6 border border-warning/30 shadow-sm mb-6">
         <h4 className="text-sm font-bold uppercase tracking-wider text-warning mb-4 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Attention Required
         </h4>
         <ul className="space-y-3">
           {warnings.map((w, i) => (
             <li key={i} className="text-sm flex gap-3 items-start bg-warning/10 p-3 rounded-md">
                <div className="text-warning mt-0.5"><AlertCircle className="w-4 h-4"/></div>
                <div>
                  <div className="font-medium text-foreground">{w.message}</div>
                  {w.fileName && <div className="text-xs text-muted-foreground mt-1">File: {w.fileName}</div>}
                </div>
             </li>
           ))}
         </ul>
       </div>
    );
  };

  const renderCompleted = () => (
    <div className="py-2 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center gap-3 mb-8 pb-4 border-b border-border">
        <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-600 flex items-center justify-center">
          <FileText className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-foreground">Discovery Complete</h2>
          <p className="text-muted-foreground text-sm font-medium">Manifest successfully generated.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-card p-4 rounded-xl border border-border shadow-sm">
          <div className="text-muted-foreground text-xs font-bold uppercase tracking-wider mb-1">Folders</div>
          <div className="text-2xl font-semibold text-foreground">{stats.totalFolders.toLocaleString()}</div>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border shadow-sm">
          <div className="text-muted-foreground text-xs font-bold uppercase tracking-wider mb-1">Files</div>
          <div className="text-2xl font-semibold text-foreground">{stats.totalFiles.toLocaleString()}</div>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border shadow-sm">
          <div className="text-muted-foreground text-xs font-bold uppercase tracking-wider mb-1">Total Size</div>
          <div className="text-2xl font-semibold text-foreground">{formatBytes(stats.totalBytes)}</div>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border shadow-sm">
          <div className="text-muted-foreground text-xs font-bold uppercase tracking-wider mb-1">Largest File</div>
          <div className="text-2xl font-semibold text-foreground">{formatBytes(stats.largestFile)}</div>
        </div>
      </div>

      {stats.storageAnalysis && renderStorageAnalysis(stats.storageAnalysis)}
      {stats.mimeStats && renderMimeBreakdown(stats.mimeStats)}
      {stats.warnings && renderWarnings(stats.warnings)}

    </div>
  );

  return (
    <div className="w-full">
      {scanState === 'Idle' && <div className="p-8 text-center text-muted-foreground">Ready to scan.</div>}
      {scanState === 'Scanning' && renderScanning()}
      {scanState === 'Completed' && renderCompleted()}
      {scanState === 'Failed' && (
        <div className="p-12 text-center border border-destructive/20 bg-destructive/5 rounded-xl">
          <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
          <h3 className="text-xl font-bold text-destructive mb-2">Discovery Failed</h3>
          <p className="text-muted-foreground mb-6">{errorMsg || 'An unknown error occurred during scanning.'}</p>
        </div>
      )}
    </div>
  );
}
