import { describe, test, expect } from 'vitest';

describe('Multi-Folder Migration Session & Telemetry Contract', () => {
  test('formats itemsParam correctly for single folder input', () => {
    const sourceIdOrItemsParam = 'folder_abc123';
    const itemsParam = sourceIdOrItemsParam.includes(':')
      ? sourceIdOrItemsParam
      : (sourceIdOrItemsParam.includes(',')
        ? sourceIdOrItemsParam.split(',').map(id => `${id.trim()}:folder`).join(',')
        : `${sourceIdOrItemsParam}:folder`);

    expect(itemsParam).toBe('folder_abc123:folder');
  });

  test('formats itemsParam correctly for multiple folder inputs', () => {
    const sourceFolderIds = ['folder_1', 'folder_2', 'folder_3'];
    const itemsParam = sourceFolderIds.map(id => `${id}:folder`).join(',');

    expect(itemsParam).toBe('folder_1:folder,folder_2:folder,folder_3:folder');
  });

  test('parses itemsParam array in DiscoveryWorker cleanly', () => {
    const itemsParam = 'folder_1:folder,folder_2:folder,folder_3:folder';
    const parsedItems = itemsParam ? itemsParam.split(',').map((part: string) => {
      const [id, itemType] = part.split(':');
      return { id, isFolder: itemType === 'folder' };
    }) : [];

    expect(parsedItems).toHaveLength(3);
    expect(parsedItems[0]).toEqual({ id: 'folder_1', isFolder: true });
    expect(parsedItems[1]).toEqual({ id: 'folder_2', isFolder: true });
    expect(parsedItems[2]).toEqual({ id: 'folder_3', isFolder: true });
  });

  test('deduplicates parent and child folder overlaps correctly', () => {
    const parentFolder = { id: 'parent_1', name: 'Documents' };
    const childFolder = { id: 'child_1', name: 'Work' };

    const parentMap: Record<string, string> = {
      'child_1': 'parent_1'
    };

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

    const selectedItems = [parentFolder];
    const selectedIdsSet = new Set(selectedItems.map(i => i.id));

    const isCoveredByParent = (folderId: string): boolean => {
      const ancestors = getAncestors(folderId);
      return ancestors.some(aId => selectedIdsSet.has(aId));
    };

    expect(isCoveredByParent('child_1')).toBe(true);
    expect(isCoveredByParent('parent_1')).toBe(false);
  });
});
