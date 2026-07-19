import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { 
  X, ChevronRight, Search, Folder, HardDrive, Clock, 
  Star, Share2
} from 'lucide-react';
import { FileIcon } from './FileIcon';

import type { DriveItem } from '../types/drive';

interface DriveBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'source' | 'destination';
  onSelectionComplete: (selection: DriveItem | DriveItem[]) => void;
}

type ViewMode = 'root' | 'shared' | 'recent' | 'starred' | 'search';

const formatBytes = (bytes?: number) => {
  if (bytes === undefined || bytes === 0) return '--';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatDate = (isoStr?: string) => {
  if (!isoStr) return '--';
  return new Date(isoStr).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric'
  });
};

export function DriveBrowserModal({ isOpen, onClose, type, onSelectionComplete }: DriveBrowserModalProps) {
  const [currentFolderId, setCurrentFolderId] = useState<string>('root');
  const [viewMode, setViewMode] = useState<ViewMode>('root');
  const [searchQuery, setSearchQuery] = useState('');
  const [breadcrumbs, setBreadcrumbs] = useState<{id: string, name: string}[]>([{ id: 'root', name: 'My Drive' }]);
  
  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Context Menu state
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, item: DriveItem } | null>(null);

  const isDestination = type === 'destination';

  const { data, isLoading } = useQuery<{files: DriveItem[], folder?: DriveItem, nextPageToken?: string}>({
    queryKey: ['drive', type, viewMode, currentFolderId, searchQuery],
    queryFn: async () => {
      let endpoint = '';
      if (viewMode === 'root') {
        if (currentFolderId === 'root') {
          endpoint = `/api/drive/${type}/root`;
        } else {
          endpoint = `/api/drive/${type}/folder/${currentFolderId}`;
        }
      }
      else if (viewMode === 'search') endpoint = `/api/drive/${type}/search?q=${encodeURIComponent(searchQuery)}`;
      else endpoint = `/api/drive/${type}/${viewMode}`;

      const res = await fetch(`http://localhost:3000${endpoint}`);
      if (!res.ok) throw new Error('Failed to fetch drive data');
      return res.json();
    },
    enabled: isOpen,
  });

  const files = data?.files || [];

  // Virtualizer setup
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48, // Row height
    overscan: 5,
  });

  // Click outside to close context menu
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // Update breadcrumb if root provides real metadata
  useEffect(() => {
    if (data?.folder && currentFolderId === 'root' && breadcrumbs.length === 1 && breadcrumbs[0].id === 'root') {
       setBreadcrumbs([{ id: data.folder.id, name: data.folder.name || 'My Drive' }]);
       setCurrentFolderId(data.folder.id);
    }
  }, [data?.folder, currentFolderId, breadcrumbs]);

  if (!isOpen) return null;

  const handleNavigate = (folder: DriveItem) => {
    if (folder.mimeType !== 'application/vnd.google-apps.folder') return;
    
    setCurrentFolderId(folder.id);
    setViewMode('root');
    setBreadcrumbs([...breadcrumbs, { id: folder.id, name: folder.name }]);
    setSelectedIds(new Set());
    setSearchQuery('');
  };

  const handleBreadcrumbClick = (id: string, index: number) => {
    setCurrentFolderId(id);
    setViewMode('root');
    setBreadcrumbs(breadcrumbs.slice(0, index + 1));
    setSelectedIds(new Set());
  };

  const toggleSelection = (e: React.MouseEvent, item: DriveItem) => {
    e.stopPropagation();
    
    // Destination can only select one folder
    if (isDestination) {
      if (item.mimeType === 'application/vnd.google-apps.folder') {
        const newSet = new Set<string>();
        if (!selectedIds.has(item.id)) newSet.add(item.id);
        setSelectedIds(newSet);
      }
      return;
    }

    const newSet = new Set(selectedIds);
    if (e.metaKey || e.ctrlKey) {
      if (newSet.has(item.id)) newSet.delete(item.id);
      else newSet.add(item.id);
    } else {
      newSet.clear();
      newSet.add(item.id);
    }
    setSelectedIds(newSet);
  };

  const handleContextMenu = (e: React.MouseEvent, item: DriveItem) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, item });
  };

  const handleConfirm = () => {
    if (selectedIds.size === 0) {
      // If nothing selected, maybe confirm the current folder if destination?
      if (isDestination && viewMode === 'root') {
        onSelectionComplete({ id: currentFolderId, name: breadcrumbs[breadcrumbs.length - 1].name, mimeType: 'application/vnd.google-apps.folder' });
      }
      return;
    }

    const selectedItems = files.filter(f => selectedIds.has(f.id));
    if (isDestination) {
      onSelectionComplete(selectedItems[0]); // Only one for destination
    } else {
      onSelectionComplete(selectedItems);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 md:p-8">
      <div className="bg-card border border-border shadow-2xl rounded-2xl w-full max-w-6xl h-full max-h-[85vh] flex flex-col overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-xl font-bold text-foreground">
            Select {isDestination ? 'Destination Folder' : 'Items to Transfer'}
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-muted rounded-full text-muted-foreground transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          
          {/* Sidebar */}
          <div className="w-64 border-r border-border bg-muted/20 p-4 flex flex-col gap-2 hidden md:flex">
            <SidebarItem icon={<HardDrive className="w-4 h-4"/>} label="My Drive" active={viewMode === 'root'} onClick={() => { setViewMode('root'); setCurrentFolderId('root'); setBreadcrumbs([{id: 'root', name: 'My Drive'}]); }} />
            {!isDestination && (
              <>
                <SidebarItem icon={<Share2 className="w-4 h-4"/>} label="Shared with me" active={viewMode === 'shared'} onClick={() => setViewMode('shared')} />
                <SidebarItem icon={<Clock className="w-4 h-4"/>} label="Recent" active={viewMode === 'recent'} onClick={() => setViewMode('recent')} />
                <SidebarItem icon={<Star className="w-4 h-4"/>} label="Starred" active={viewMode === 'starred'} onClick={() => setViewMode('starred')} />
              </>
            )}
          </div>

          {/* Main Content */}
          <div className="flex-1 flex flex-col bg-background overflow-hidden relative">
            
            {/* Toolbar */}
            <div className="p-4 border-b border-border flex items-center justify-between bg-card">
              
              {/* Breadcrumbs */}
              <div className="flex items-center text-sm overflow-hidden flex-1">
                {viewMode === 'root' ? breadcrumbs.map((crumb, idx) => (
                  <div key={crumb.id} className="flex items-center">
                    {idx > 0 && <ChevronRight className="w-4 h-4 mx-1 text-muted-foreground flex-shrink-0" />}
                    <button 
                      onClick={() => handleBreadcrumbClick(crumb.id, idx)}
                      className={`truncate max-w-[150px] hover:underline ${idx === breadcrumbs.length - 1 ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
                    >
                      {crumb.name}
                    </button>
                  </div>
                )) : (
                  <div className="font-semibold text-foreground capitalize">{viewMode}</div>
                )}
              </div>

              {/* Search */}
              <div className="relative ml-4 flex-shrink-0">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input 
                  type="text" 
                  placeholder="Search in Drive..." 
                  className="pl-9 pr-4 py-2 text-sm bg-muted border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 w-64"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && searchQuery.trim()) {
                      setViewMode('search');
                    }
                  }}
                />
              </div>
            </div>

            {/* List Header */}
            <div className="grid grid-cols-[1fr_120px_150px] gap-4 px-6 py-3 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/10">
              <div>Name</div>
              <div>Size</div>
              <div>Modified</div>
            </div>

            {/* File List (Virtualized) */}
            <div ref={parentRef} className="flex-1 overflow-auto relative">
              {isLoading ? (
                <div className="p-6 space-y-4">
                  {[...Array(10)].map((_, i) => (
                    <div key={i} className="flex items-center gap-4 animate-pulse">
                      <div className="w-6 h-6 bg-muted rounded"></div>
                      <div className="flex-1 h-5 bg-muted rounded"></div>
                      <div className="w-20 h-5 bg-muted rounded"></div>
                      <div className="w-24 h-5 bg-muted rounded"></div>
                    </div>
                  ))}
                </div>
              ) : files.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <Folder className="w-16 h-16 mb-4 opacity-20" />
                  <p>This folder is empty</p>
                </div>
              ) : (
                <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const item = files[virtualRow.index];
                    const isSelected = selectedIds.has(item.id);
                    const isFolder = item.mimeType === 'application/vnd.google-apps.folder';
                    
                    // Destination restrictions
                    const isDisabled = isDestination && !isFolder;

                    return (
                      <div
                        key={virtualRow.index}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                        className={`
                          grid grid-cols-[1fr_120px_150px] gap-4 px-6 items-center border-b border-border/50 text-sm transition-colors cursor-pointer group
                          ${isSelected ? 'bg-primary/10 border-primary/20' : 'hover:bg-muted/30'}
                          ${isDisabled ? 'opacity-50 cursor-not-allowed' : ''}
                        `}
                        onClick={(e) => !isDisabled && toggleSelection(e, item)}
                        onDoubleClick={() => isFolder && handleNavigate(item)}
                        onContextMenu={(e) => !isDisabled && handleContextMenu(e, item)}
                      >
                        <div className="flex items-center gap-3 overflow-hidden">
                          <FileIcon mimeType={item.mimeType} className="w-5 h-5 flex-shrink-0" />
                          <span className="truncate text-foreground group-hover:text-primary transition-colors">{item.name}</span>
                        </div>
                        <div className="text-muted-foreground text-xs">{isFolder ? '--' : formatBytes(item.size)}</div>
                        <div className="text-muted-foreground text-xs truncate">{formatDate(item.modifiedTime)}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Context Menu Overlay */}
            {contextMenu && (
              <div 
                className="fixed bg-popover border border-border rounded-lg shadow-lg py-1 z-[100] w-48 text-sm overflow-hidden"
                style={{ top: contextMenu.y, left: contextMenu.x }}
              >
                {contextMenu.item.mimeType === 'application/vnd.google-apps.folder' && (
                  <button 
                    className="w-full text-left px-4 py-2 hover:bg-muted text-foreground transition-colors"
                    onClick={() => { handleNavigate(contextMenu.item); setContextMenu(null); }}
                  >
                    Open Folder
                  </button>
                )}
                <button 
                  className="w-full text-left px-4 py-2 hover:bg-muted text-foreground transition-colors"
                  onClick={() => { navigator.clipboard.writeText(contextMenu.item.id); setContextMenu(null); }}
                >
                  Copy ID
                </button>
                <div className="border-t border-border my-1"></div>
                <button 
                  className="w-full text-left px-4 py-2 hover:bg-muted text-foreground transition-colors"
                  onClick={() => setContextMenu(null)}
                >
                  Properties
                </button>
              </div>
            )}

          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border bg-card flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            {selectedIds.size > 0 ? (
              <span className="font-medium text-foreground">{selectedIds.size} item(s) selected</span>
            ) : (
              isDestination && viewMode === 'root' ? 
              <span>Will transfer into: <span className="font-semibold text-foreground">{breadcrumbs[breadcrumbs.length - 1].name}</span></span> :
              'Select an item to continue'
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-4 py-2 rounded-lg font-medium hover:bg-muted transition-colors">
              Cancel
            </button>
            <button 
              onClick={handleConfirm}
              disabled={selectedIds.size === 0 && (!isDestination || viewMode !== 'root')}
              className="bg-primary text-primary-foreground px-6 py-2 rounded-lg font-medium shadow-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              Confirm Selection
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

function SidebarItem({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
        active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
