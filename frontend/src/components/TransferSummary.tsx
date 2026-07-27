import { useState, useEffect } from 'react';
import { API_URL } from '../config/api';
import { ArrowRight, HardDrive, FolderOpen, File as FileIcon, Loader2, AlertCircle, FileText, LayoutGrid, MonitorPlay, HelpCircle, Copy } from 'lucide-react';
import type { DriveItem } from '../types/drive';
import type { ScanSummaryResult } from '../types/drive';

export interface TransferSummaryProps {
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

export function TransferSummary({ sourceSelection, destinationFolder, onScanComplete }: TransferSummaryProps) {
  const [scanState, setScanState] = useState<'Idle' | 'Scanning' | 'Completed' | 'Failed' | 'Disconnected'>('Idle');
  const [scanStats, setScanStats] = useState<ScanSummaryResult>({
    selectedItems: 0,
    folderCount: 0,
    fileCount: 0,
    totalBytes: 0,
    googleDocs: 0,
    googleSheets: 0,
    googleSlides: 0,
    unsupported: 0,
    duplicates: 0,
    largestFile: 0,
    scanStatus: 'Idle'
  });
  const [currentAction, setCurrentAction] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (sourceSelection.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setScanState('Idle');
      return;
    }

    setScanState('Scanning');
    setErrorMsg(null);
    setCurrentAction('Connecting to scan stream...');

    const itemsParam = sourceSelection.map(item => {
      const isFolder = item.mimeType === 'application/vnd.google-apps.folder' 
                    || item.mimeType === 'application/vnd.google-apps.shortcut'
                    || item.mimeType?.includes('folder');
      return `${item.id}:${isFolder ? 'folder' : 'file'}`;
    }).join(',');

    const url = `${API_URL}/api/drive/source/summary?items=${encodeURIComponent(itemsParam)}`;
    const eventSource = new EventSource(url, { withCredentials: true });

    eventSource.onopen = () => {
      console.log('[Frontend] SSE connection opened.');
      setCurrentAction('Connected. Starting scan...');
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'connected') return;

        if (data.error || data.scanStatus === 'Failed') {
          console.error('Scan error:', data.error);
          setScanState('Failed');
          setErrorMsg(data.error || 'Failed to connect to scan stream');
          eventSource.close();
          return;
        }

        if (data.complete || data.scanStatus === 'Completed') {
          setScanState('Completed');
          setCurrentAction('');
          setScanStats(prev => ({ ...prev, ...data }));
          if (onScanComplete && data.manifestId) {
             onScanComplete(data.manifestId, data as ScanSummaryResult);
          }
          eventSource.close();
          return;
        }

        if (data.scanStatus === 'Scanning') {
          setScanStats(prev => ({ ...prev, ...data }));
          if (data.currentAction) {
            setCurrentAction(data.currentAction);
          }
        }
      } catch (err) {
        console.error('Error parsing SSE data', err);
      }
    };

    eventSource.onerror = (err) => {
      console.error('[Frontend] SSE Error:', err);
      if (scanState !== 'Completed') {
         setScanState('Failed');
         setErrorMsg('Failed to connect to scan stream');
      }
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [sourceSelection]);

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
      <h3 className="text-lg font-semibold text-foreground mb-6 border-b border-border pb-4 flex justify-between items-center">
        <span>Transfer Summary</span>
        <span className={`text-xs font-medium px-2 py-1 rounded-full ${
          scanState === 'Completed' ? 'bg-green-100 text-green-700' :
          scanState === 'Failed' ? 'bg-red-100 text-red-700' :
          scanState === 'Scanning' ? 'bg-blue-100 text-blue-700' :
          'bg-gray-100 text-gray-700'
        }`}>
          {scanState}
        </span>
      </h3>
      
      {scanState === 'Failed' && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 mt-0.5" />
          <div>
            <h4 className="font-medium text-red-800">Scan Failed</h4>
            <p className="text-sm text-red-600">{errorMsg}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-6">
        
        {/* Source Side */}
        <div className="space-y-4">
          <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Source Workload</div>
          {sourceSelection.length === 0 ? (
            <div className="text-sm text-muted-foreground italic">No items selected</div>
          ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-blue-500" />
                    <span className="font-medium text-foreground">{scanStats.folderCount} Folders</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <FileIcon className="w-4 h-4 text-gray-500" />
                    <span className="font-medium text-foreground">{scanStats.fileCount} Files</span>
                  </div>
                  <div className="flex items-center gap-2 col-span-2">
                    <HardDrive className="w-4 h-4 text-emerald-500" />
                    <span className="font-medium text-foreground">Total Size: {formatBytes(scanStats.totalBytes)}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs bg-muted/50 p-3 rounded-lg border border-border">
                  <div className="flex items-center gap-1.5"><FileText className="w-3.5 h-3.5 text-blue-600"/> Docs: {scanStats.googleDocs}</div>
                  <div className="flex items-center gap-1.5"><LayoutGrid className="w-3.5 h-3.5 text-green-600"/> Sheets: {scanStats.googleSheets}</div>
                  <div className="flex items-center gap-1.5"><MonitorPlay className="w-3.5 h-3.5 text-yellow-600"/> Slides: {scanStats.googleSlides}</div>
                  <div className="flex items-center gap-1.5"><HelpCircle className="w-3.5 h-3.5 text-gray-400"/> Unsupp.: {scanStats.unsupported}</div>
                  <div className="flex items-center gap-1.5 col-span-2"><Copy className="w-3.5 h-3.5 text-orange-500"/> Duplicates: {scanStats.duplicates}</div>
                </div>

                {scanState === 'Scanning' && (
                  <div className="pt-2 border-t border-border mt-2">
                    <div className="flex items-center gap-2 text-xs text-primary font-medium mb-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Scanning Drive...
                    </div>
                    {currentAction && <div className="text-[10px] text-muted-foreground truncate" title={currentAction}>{currentAction}</div>}
                  </div>
                )}
              </div>
          )}
        </div>

        {/* Arrow */}
        <div className="hidden md:flex flex-col items-center justify-center pt-8">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <ArrowRight className="w-5 h-5 text-primary" />
          </div>
        </div>

        {/* Destination Side */}
        <div className="space-y-4">
          <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Destination</div>
          {!destinationFolder ? (
            <div className="text-sm text-muted-foreground italic">No destination selected</div>
          ) : (
            <div className="bg-secondary/50 p-3 rounded-lg border border-border">
              <div className="flex items-center gap-3">
                <FolderOpen className="w-8 h-8 text-blue-500 flex-shrink-0" />
                <div className="overflow-hidden">
                  <div className="font-medium text-sm text-foreground truncate" title={destinationFolder.name}>
                    {destinationFolder.name}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    Destination Root
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

