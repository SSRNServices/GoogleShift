export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  icon?: string;
  thumbnail?: string;
  parentId?: string;
}

export interface DriveFolder extends DriveItem {
  // Folder specific properties if any
}

export interface DriveFile extends DriveItem {
  // File specific properties if any
}

export type SelectionMode = 'ENTIRE_DRIVE' | 'FOLDER' | 'FILES';

export interface FolderSelection {
  folder: DriveFolder;
}

export interface FileSelection {
  files: DriveFile[];
}
