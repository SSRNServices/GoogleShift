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

export type DriveFolder = DriveItem;
export type DriveFile = DriveItem;

export type SelectionMode = 'ENTIRE_DRIVE' | 'FOLDER' | 'FILES';

export interface FolderSelection {
  folder: DriveFolder;
}

export interface FileSelection {
  files: DriveFile[];
}
