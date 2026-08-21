import { useState, useEffect, useMemo } from 'react';
import { apiClient } from '../api/apiClient';
import type { DriveItem } from '../types/drive';
import { 
  Folder, 
  ChevronRight, 
  Loader2, 
  Search, 
  CheckSquare, 
  Square, 
  X, 
  FolderCheck,
  AlertCircle
} from 'lucide-react';

interface SourceFolderSelectorProps {
  selectedItems: DriveItem[];
  onChange: (items: DriveItem[]) => void;
}

export function SourceFolderSelector({ selectedItems, onChange }: SourceFolderSelectorProps) {
  const [rootItems, setRootItems] = useState<DriveItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [childrenMap, setChildrenMap] = useState<Record<string, DriveItem[]>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [expandedSet, setExpandedSet] = useState<Set<string>>(new Set());

  // Parent tracking map: childFolderId -> parentFolderId
  const [parentMap, setParentMap] = useState<Record<string, string>>({});

  useEffect(() => {
    const fetchRoot = async () => {
      try {
        setLoading(true);
        setError(false);
        const data = await apiClient('/api/drive/source/root');
        const folders = (data.files || []).filter((f: DriveItem) => f.mimeType === 'application/vnd.google-apps.folder');
        setRootItems(folders);
      } catch (e) {
        console.error('Failed to load source root folders:', e);
        setError(true);
      } finally {
        setLoading(false);
      }
    };
    fetchRoot();
  }, []);

  const selectedIdsSet = useMemo(() => new Set(selectedItems.map(i => i.id)), [selectedItems]);

  // Helper to find all ancestor folder IDs for a given folder ID
  const getAncestors = (folderId: string): string[] => {
    const ancestors: string[] = [];
    let currentId = folderId;
    while (parentMap[currentId]) {
      const pId = parentMap[currentId];
      ancestors.push(pId);
      currentId = pId;
    }
    return ancestors;
  };

  // Determine if a folder is redundant because a parent ancestor is already selected
  const isCoveredByParent = (folderId: string): boolean => {
    const ancestors = getAncestors(folderId);
    return ancestors.some(aId => selectedIdsSet.has(aId));
  };

  const handleToggleExpand = async (item: DriveItem) => {
    const isExpanded = expandedSet.has(item.id);
    const newSet = new Set(expandedSet);
    if (isExpanded) {
      newSet.delete(item.id);
    } else {
      newSet.add(item.id);
      if (!childrenMap[item.id]) {
        setLoadingMap(prev => ({ ...prev, [item.id]: true }));
        try {
          const data = await apiClient(`/api/drive/source/folder/${item.id}`);
          const folders = (data.files || []).filter((f: DriveItem) => f.mimeType === 'application/vnd.google-apps.folder');
          setChildrenMap(prev => ({ ...prev, [item.id]: folders }));
          setParentMap(prev => {
            const next = { ...prev };
            folders.forEach((child: DriveItem) => {
              next[child.id] = item.id;
            });
            return next;
          });
        } catch (err) {
          console.error(`Failed to load subfolders for ${item.name}:`, err);
        } finally {
          setLoadingMap(prev => ({ ...prev, [item.id]: false }));
        }
      }
    }
    setExpandedSet(newSet);
  };

  const handleToggleSelect = (item: DriveItem) => {
    if (selectedIdsSet.has(item.id)) {
      // Deselect
      onChange(selectedItems.filter(i => i.id !== item.id));
    } else {
      // Select item and remove any redundant descendant selections covered by this item
      const newItems = selectedItems.filter(existing => {
        const ancestors = getAncestors(existing.id);
        return !ancestors.includes(item.id);
      });
      onChange([...newItems, item]);
    }
  };

  const handleSelectAllVisible = () => {
    const visibleFolders = rootItems.filter(item => 
      !searchQuery || item.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    // Merge visible folders while preserving deduplication
    const newItems = [...selectedItems];
    visibleFolders.forEach(folder => {
      if (!newItems.some(i => i.id === folder.id)) {
        newItems.push(folder);
      }
    });
    onChange(newItems);
  };

  const handleClearAll = () => {
    onChange([]);
  };

  const renderFolderItem = (item: DriveItem, depth: number = 0) => {
    const isSelected = selectedIdsSet.has(item.id);
    const coveredByParent = isCoveredByParent(item.id);
    const isExpanded = expandedSet.has(item.id);
    const isLoadingChildren = Boolean(loadingMap[item.id]);
    const children = childrenMap[item.id] || [];

    const matchesSearch = !searchQuery || item.name.toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchesSearch && depth === 0 && !isExpanded) {
      return null;
    }

    return (
      <div key={item.id} className="select-none">
        <div 
          className={`flex items-center justify-between py-2 px-3 my-0.5 rounded-lg border transition-all duration-150 ${
            isSelected 
              ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-800 text-indigo-950 dark:text-indigo-200 shadow-2xs' 
              : coveredByParent
              ? 'bg-gray-50 dark:bg-gray-800/40 border-dashed border-gray-200 dark:border-gray-700 text-gray-500 opacity-80'
              : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/60 text-gray-800 dark:text-gray-200'
          }`}
          style={{ paddingLeft: `${depth * 1.5 + 0.75}rem` }}
        >
          <div className="flex items-center space-x-3 flex-1 min-w-0">
            {/* Chevron toggle expand */}
            <button
              type="button"
              onClick={() => handleToggleExpand(item)}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded transition-colors focus:outline-none"
              title={isExpanded ? 'Collapse folder' : 'Expand folder'}
            >
              {isLoadingChildren ? (
                <Loader2 className="w-4 h-4 animate-spin text-indigo-500" />
              ) : (
                <ChevronRight className={`w-4 h-4 transition-transform duration-200 ${isExpanded ? 'rotate-90 text-indigo-600 dark:text-indigo-400' : ''}`} />
              )}
            </button>

            {/* Checkbox for selection */}
            <button
              type="button"
              disabled={coveredByParent}
              onClick={() => handleToggleSelect(item)}
              className={`p-0.5 rounded focus:outline-none transition-colors ${coveredByParent ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
              title={coveredByParent ? 'Parent folder already selected' : (isSelected ? 'Deselect folder' : 'Select folder')}
            >
              {isSelected ? (
                <CheckSquare className="w-5 h-5 text-indigo-600 dark:text-indigo-400 fill-indigo-100 dark:fill-indigo-950" />
              ) : coveredByParent ? (
                <Square className="w-5 h-5 text-gray-300 dark:text-gray-600" />
              ) : (
                <Square className="w-5 h-5 text-gray-400 hover:text-indigo-500 transition-colors" />
              )}
            </button>

            {/* Folder Icon & Name */}
            <Folder className={`w-4 h-4 flex-shrink-0 ${isSelected ? 'text-indigo-600 dark:text-indigo-400' : 'text-blue-500 dark:text-blue-400'}`} />
            
            <span 
              className={`text-sm font-medium truncate cursor-pointer ${isSelected ? 'font-semibold text-indigo-900 dark:text-indigo-200' : ''}`}
              onClick={() => !coveredByParent && handleToggleSelect(item)}
            >
              {item.name}
            </span>
          </div>

          {/* Badge Indicators */}
          {isSelected && (
            <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 font-semibold border border-indigo-200 dark:border-indigo-800 flex-shrink-0">
              Selected
            </span>
          )}
          {coveredByParent && (
            <span className="ml-2 text-2xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 font-medium border border-gray-200 dark:border-gray-700 flex-shrink-0">
              Included in Parent
            </span>
          )}
        </div>

        {/* Nested Subfolders */}
        {isExpanded && (
          <div className="border-l border-gray-100 dark:border-gray-800 ml-4 pl-1 my-0.5">
            {children.length === 0 && !isLoadingChildren ? (
              <div className="text-xs text-gray-400 italic py-1.5 pl-6">No subfolders found</div>
            ) : (
              children.map(child => renderFolderItem(child, depth + 1))
            )}
          </div>
        )}
      </div>
    );
  };

  const filteredCount = rootItems.filter(item => 
    !searchQuery || item.name.toLowerCase().includes(searchQuery.toLowerCase())
  ).length;

  return (
    <div className="space-y-4">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {/* Search Bar */}
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search source folders..."
            className="w-full pl-9 pr-8 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center space-x-2 flex-shrink-0">
          <button
            type="button"
            onClick={handleSelectAllVisible}
            disabled={filteredCount === 0}
            className="px-3 py-1.5 text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md transition-colors disabled:opacity-50"
          >
            Select All Visible
          </button>
          <button
            type="button"
            onClick={handleClearAll}
            disabled={selectedItems.length === 0}
            className="px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 hover:bg-red-100 dark:hover:bg-red-900/40 border border-red-200 dark:border-red-900 rounded-md transition-colors disabled:opacity-50"
          >
            Clear Selection
          </button>
        </div>
      </div>

      {/* Selected Items Summary Bar */}
      {selectedItems.length > 0 && (
        <div className="p-3 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center space-x-2 text-indigo-900 dark:text-indigo-200 font-semibold text-sm">
              <FolderCheck className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>{selectedItems.length} folder{selectedItems.length > 1 ? 's' : ''} selected for migration</span>
            </div>
            <button
              onClick={handleClearAll}
              className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
            >
              Deselect All
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto pt-1">
            {selectedItems.map(item => (
              <span
                key={item.id}
                className="inline-flex items-center space-x-1.5 text-xs bg-white dark:bg-indigo-900/60 text-indigo-900 dark:text-indigo-200 px-2.5 py-1 rounded-md border border-indigo-200 dark:border-indigo-700 shadow-2xs font-medium"
              >
                <Folder className="w-3.5 h-3.5 text-indigo-500" />
                <span className="max-w-xs truncate">{item.name}</span>
                <button
                  type="button"
                  onClick={() => onChange(selectedItems.filter(i => i.id !== item.id))}
                  className="text-indigo-400 hover:text-indigo-700 dark:hover:text-white rounded ml-1"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Main Folder Tree Area */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-3 max-h-96 overflow-y-auto bg-white dark:bg-gray-900 shadow-2xs">
        {loading ? (
          <div className="p-8 flex flex-col items-center justify-center space-y-3">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
            <p className="text-sm text-gray-500">Loading source Google Drive folders...</p>
          </div>
        ) : error ? (
          <div className="p-6 text-center text-red-500 font-medium border border-red-200 rounded-lg bg-red-50 dark:bg-red-950/40 dark:border-red-900 flex items-center justify-center space-x-2">
            <AlertCircle className="w-5 h-5" />
            <span>Failed to load source folders. Please check your source account connection.</span>
          </div>
        ) : rootItems.length === 0 ? (
          <div className="p-8 text-center text-gray-500 italic border border-gray-200 dark:border-gray-800 rounded-lg bg-gray-50 dark:bg-gray-800/50">
            No folders found in source Google Drive root directory.
          </div>
        ) : (
          <div className="space-y-0.5">
            {rootItems.map(item => renderFolderItem(item, 0))}
          </div>
        )}
      </div>
    </div>
  );
}
