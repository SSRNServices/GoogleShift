import {
  Folder,
  FileText,
  Image as ImageIcon,
  FileVideo,
  FileAudio,
  FileArchive,
  Table,
  Presentation,
  File
} from 'lucide-react';

interface FileIconProps {
  mimeType: string;
  className?: string;
}

export function FileIcon({ mimeType, className = "w-5 h-5 text-muted-foreground" }: FileIconProps) {
  if (mimeType === 'application/vnd.google-apps.folder') {
    return <Folder className={`fill-current text-blue-500 ${className}`} />;
  }
  if (mimeType === 'application/vnd.google-apps.document') {
    return <FileText className={`text-blue-600 ${className}`} />;
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    return <Table className={`text-emerald-600 ${className}`} />;
  }
  if (mimeType === 'application/vnd.google-apps.presentation') {
    return <Presentation className={`text-amber-500 ${className}`} />;
  }
  if (mimeType.startsWith('image/')) {
    return <ImageIcon className={`text-red-500 ${className}`} />;
  }
  if (mimeType.startsWith('video/')) {
    return <FileVideo className={`text-red-600 ${className}`} />;
  }
  if (mimeType.startsWith('audio/')) {
    return <FileAudio className={`text-purple-500 ${className}`} />;
  }
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('rar')) {
    return <FileArchive className={`text-yellow-600 ${className}`} />;
  }
  
  return <File className={className} />;
}
