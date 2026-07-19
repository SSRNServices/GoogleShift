import { ArrowRight, HardDrive, FolderOpen, File as FileIcon } from 'lucide-react';
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
  const folders = sourceSelection.filter(item => item.mimeType === 'application/vnd.google-apps.folder');
  const files = sourceSelection.filter(item => item.mimeType !== 'application/vnd.google-apps.folder');
  
  const totalSize = sourceSelection.reduce((acc, item) => acc + (item.size || 0), 0);

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
                <span className="font-medium text-foreground">{folders.length} Folders</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <FileIcon className="w-4 h-4 text-muted-foreground" />
                <span className="font-medium text-foreground">{files.length} Files</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <HardDrive className="w-4 h-4 text-emerald-500" />
                <span className="font-medium text-foreground">Estimated Size: {formatBytes(totalSize)}</span>
              </div>
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
