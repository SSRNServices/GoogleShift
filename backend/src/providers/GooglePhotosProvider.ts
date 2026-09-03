import { OAuth2Client } from 'google-auth-library';
import { Readable, PassThrough } from 'stream';
import axios from 'axios';

export interface PhotosMediaItem {
  id: string;
  description?: string;
  productUrl?: string;
  baseUrl: string;
  mimeType: string;
  mediaMetadata?: {
    creationTime?: string;
    width?: string;
    height?: string;
    photo?: Record<string, any>;
    video?: Record<string, any>;
  };
  filename: string;
}

export interface PhotosAlbum {
  id: string;
  title: string;
  productUrl?: string;
  mediaItemsCount?: string | number;
  coverPhotoBaseUrl?: string;
}

export interface BatchCreateResult {
  uploadToken: string;
  status: { message?: string; code?: number };
  mediaItem?: {
    id: string;
    productUrl?: string;
    baseUrl?: string;
    mimeType?: string;
    filename?: string;
  };
}

export class GooglePhotosProvider {
  private baseUrl = 'https://photoslibrary.googleapis.com/v1';

  constructor(private oauthClient: OAuth2Client) {}

  private async getAccessToken(): Promise<string> {
    const tokenRes = await this.oauthClient.getAccessToken();
    const token = tokenRes?.token || this.oauthClient.credentials?.access_token;
    if (!token) {
      throw new Error('Google Photos API OAuth access token is missing or expired.');
    }
    return token;
  }

  public async listMediaItems(pageToken?: string): Promise<{ mediaItems: PhotosMediaItem[]; nextPageToken?: string }> {
    const accessToken = await this.getAccessToken();
    const response = await axios.get(`${this.baseUrl}/mediaItems`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        pageSize: 100,
        ...(pageToken ? { pageToken } : {})
      }
    });

    return {
      mediaItems: response.data.mediaItems || [],
      nextPageToken: response.data.nextPageToken || undefined
    };
  }

  public async listAlbums(pageToken?: string): Promise<{ albums: PhotosAlbum[]; nextPageToken?: string }> {
    const accessToken = await this.getAccessToken();
    const response = await axios.get(`${this.baseUrl}/albums`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        pageSize: 50,
        ...(pageToken ? { pageToken } : {})
      }
    });

    return {
      albums: response.data.albums || [],
      nextPageToken: response.data.nextPageToken || undefined
    };
  }

  public async listAlbumMediaItems(albumId: string, pageToken?: string): Promise<{ mediaItems: PhotosMediaItem[]; nextPageToken?: string }> {
    const accessToken = await this.getAccessToken();
    const response = await axios.post(
      `${this.baseUrl}/mediaItems:search`,
      {
        albumId,
        pageSize: 100,
        ...(pageToken ? { pageToken } : {})
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return {
      mediaItems: response.data.mediaItems || [],
      nextPageToken: response.data.nextPageToken || undefined
    };
  }

  public async createAlbum(title: string): Promise<PhotosAlbum> {
    const accessToken = await this.getAccessToken();
    const response = await axios.post(
      `${this.baseUrl}/albums`,
      {
        album: { title }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  }

  public async downloadMediaStream(baseUrl: string, isVideo: boolean = false): Promise<Readable> {
    const downloadUrl = isVideo ? `${baseUrl}=dv` : `${baseUrl}=d`;
    const response = await axios.get(downloadUrl, {
      responseType: 'stream',
      timeout: 60000
    });

    return response.data;
  }

  public async uploadMediaStream(stream: Readable, mimeType: string, filename: string, size?: number): Promise<string> {
    const accessToken = await this.getAccessToken();

    const response = await axios.post(`${this.baseUrl}/uploads`, stream, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-type': 'application/octet-stream',
        'X-Goog-Upload-Content-Type': mimeType || 'application/octet-stream',
        'X-Goog-Upload-Protocol': 'raw',
        ...(filename ? { 'X-Goog-Upload-File-Name': encodeURIComponent(filename) } : {})
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000
    });

    const uploadToken = typeof response.data === 'string' ? response.data.trim() : String(response.data).trim();
    if (!uploadToken) {
      throw new Error('Google Photos API failed to return a valid uploadToken.');
    }

    return uploadToken;
  }

  public async batchCreateMediaItems(
    items: Array<{ description?: string; uploadToken: string; fileName?: string }>,
    albumId?: string
  ): Promise<BatchCreateResult[]> {
    if (items.length === 0) return [];
    const accessToken = await this.getAccessToken();

    const newMediaItems = items.map(item => ({
      description: item.description || '',
      simpleMediaItem: {
        uploadToken: item.uploadToken,
        fileName: item.fileName || undefined
      }
    }));

    const response = await axios.post(
      `${this.baseUrl}/mediaItems:batchCreate`,
      {
        albumId: albumId || undefined,
        newMediaItems
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const results: any[] = response.data.newMediaItemResults || [];
    return results.map((r, i) => ({
      uploadToken: items[i]?.uploadToken || '',
      status: r.status || { message: 'Success' },
      mediaItem: r.mediaItem
    }));
  }

  public async batchAddMediaItemsToAlbum(albumId: string, mediaItemIds: string[]): Promise<void> {
    if (mediaItemIds.length === 0) return;
    const accessToken = await this.getAccessToken();

    await axios.post(
      `${this.baseUrl}/albums/${albumId}:batchAddMediaItems`,
      { mediaItemIds },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
  }
}
