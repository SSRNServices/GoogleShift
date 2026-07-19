import { useState, useEffect } from 'react';
import { ArrowRight, HardDrive, FolderOpen, File as FileIcon, Loader2 } from 'lucide-react';
import type { DriveItem } from '../types/drive';

export interface TransferSummaryProps {
  sourceSelection: DriveItem[];
  destinationFolder: DriveItem | null;
}

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export function TransferSummary({ sourceSelection, destinationFolder }: TransferSummaryProps) {
  const [isScanning, setIsScanning] = useState(false);
  const [scanStats, setScanStats] = useState({ folders: 0, files: 0, bytes: 0 });
  const [currentAction, setCurrentAction] = useState<string>('');

  useEffect(() => {
    if (sourceSelection.length === 0) {
      setScanStats({ folders: 0, files: 0, bytes: 0 });
      setCurrentAction('');
      setIsScanning(false);
      return;
    }

    setIsScanning(true);
    setScanStats({ folders: 0, files: 0, bytes: 0 });
    setCurrentAction('Starting scan...');

    console.log('[Frontend] Folder selected for scan. Item count:', sourceSelection.length);

    // Convert selection into items parameter: id1:folder,id2:file
    const itemsParam = sourceSelection.map(item => {
      const isFolder = item.mimeType === 'application/vnd.google-apps.folder';
      return `${item.id}:${isFolder ? 'folder' : 'file'}`;
    }).join(',');

    const url = `http://localhost:3000/api/drive/source/summary?items=${encodeURIComponent(itemsParam)}`;
    console.log('[Frontend] Summary request started. URL:', url);
    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      console.log('[Frontend] SSE connection opened successfully.');
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.error) {
          console.error('Scan error:', data.error);
          setCurrentAction(`Error: ${data.error}`);
          setIsScanning(false);
          eventSource.close();
          return;
        }

        if (data.complete) {
          console.log('[Frontend] Scanning completed. Final summary received:', data);
          setIsScanning(false);
          setCurrentAction('');
          setScanStats({
            folders: data.folders,
            files: data.files,
            bytes: data.bytes
          });
          eventSource.close();
          return;
        }

        setScanStats({
          folders: data.folders,
          files: data.files,
          bytes: data.bytes
        });
        if (data.currentAction) {
          setCurrentAction(data.currentAction);
        }

      } catch (err) {
        console.error('Error parsing SSE data', err);
      }
    };

    eventSource.onerror = (err) => {
      console.error('[Frontend] Summary failed / SSE Error:', err);
      setIsScanning(false);
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [sourceSelection]);

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
      <h3 className="text-lg font-semibold text-foreground mb-6 border-b border-border pb-4">Transfer Summary</h3>
      
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-6 items-center">
        
        {/* Source Side */}
        <div className="space-y-4">
          <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Source</div>
          {sourceSelection.length === 0 ? (
            <div className="text-sm text-muted-foreground italic">No items selected</div>
          ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <FolderOpen className="w-4 h-4 text-blue-500" />
                  <span className="font-medium text-foreground">{scanStats.folders} Folders</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <FileIcon className="w-4 h-4 text-muted-foreground" />
                  <span className="font-medium text-foreground">{scanStats.files} Files</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <HardDrive className="w-4 h-4 text-emerald-500" />
                  <span className="font-medium text-foreground">Estimated Size: {formatBytes(scanStats.bytes)}</span>
                </div>
                {isScanning && (
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
        <div className="hidden md:flex flex-col items-center justify-center">
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
