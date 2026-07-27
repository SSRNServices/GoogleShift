import { ArrowRight, HardDrive, FolderOpen, File as FileIcon } from 'lucide-react';
import type { DriveItem } from '../types/drive';

export interface TransferSummaryProps {
  sourceSelection: DriveItem[];
  destinationFolder: DriveItem | null;
  onScanComplete?: (manifestId: string, stats: { folders: number, files: number, bytes: number }) => void;
}

export function TransferSummary({ sourceSelection, destinationFolder, onScanComplete }: TransferSummaryProps) {
  // We simply pass the actual manifest generation to the backend `/start` route.
  // There is no pre-scan needed anymore! We just notify the parent that they can proceed.
  // Wait, if we call onScanComplete here immediately, the parent will enable the Start button.
  // So we call it whenever sourceSelection or destinationFolder changes.
  
  // Actually, we don't even need onScanComplete to pass a manifestId anymore!
  // We'll just pass a dummy string so the parent's `manifestId !== null` check passes, 
  // or we'll modify the parent to ignore manifestId.
  // Let's call it with a dummy ID just to keep the prop signature compatible for now.

  if (sourceSelection.length > 0 && destinationFolder && onScanComplete) {
     // Delay slightly to prevent render loop warnings if called directly in render
     setTimeout(() => onScanComplete('ready', { folders: 0, files: 0, bytes: 0 }), 0);
  }

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
                  <span className="font-medium text-foreground">{sourceSelection.length} Items Selected</span>
                </div>
                <div className="pt-2 border-t border-border mt-2">
                    <div className="text-xs text-muted-foreground">
                      Full deep scan will occur automatically after starting the migration.
                    </div>
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

