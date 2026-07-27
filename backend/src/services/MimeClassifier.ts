export class MimeClassifier {
  public static classify(mimeType?: string | null): keyof MimeStatsPayload {
    if (!mimeType) return 'other';

    if (mimeType === 'application/vnd.google-apps.document') return 'googleDocs';
    if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'googleSheets';
    if (mimeType === 'application/vnd.google-apps.presentation') return 'googleSlides';
    if (mimeType === 'application/pdf') return 'pdf';
    
    if (mimeType.startsWith('image/')) return 'images';
    if (mimeType.startsWith('video/')) return 'videos';
    if (mimeType.startsWith('audio/')) return 'other';
    
    if (mimeType === 'application/zip' || mimeType === 'application/x-rar-compressed' || mimeType === 'application/x-tar' || mimeType === 'application/gzip') return 'archives';

    if (mimeType.includes('vnd.google-apps') && mimeType !== 'application/vnd.google-apps.shortcut' && mimeType !== 'application/vnd.google-apps.folder') {
      return 'unsupported';
    }

    return 'other';
  }
}

export interface MimeStatsPayload {
  googleDocs: number;
  googleSheets: number;
  googleSlides: number;
  pdf: number;
  images: number;
  videos: number;
  archives: number;
  unsupported: number;
  duplicates: number;
  other: number;
}
