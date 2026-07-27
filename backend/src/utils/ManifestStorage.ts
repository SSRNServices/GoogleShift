// @ts-nocheck
import { prisma } from './database';

export interface ManifestItem {
  id: string;
  jobId: string;
  sourceId: string;
  sourceParentId: string;
  destParentId: string | null;
  createdDestId: string | null;
  name: string;
  mimeType: string;
  size: number;
  originalId: string | null;
  originalMimeType: string | null;
  status: 'PENDING' | 'QUEUED' | 'DOWNLOADING' | 'UPLOADING' | 'VERIFYING' | 'SUCCESS' | 'FAILED';
  isFolder: boolean;
  depth: number;
  retryCount: number;
}

export class ManifestStorage {
  public static async createManifestTable() {
    // Handled by Prisma
  }

  public static async insertItem(item: ManifestItem) {
    await prisma.migrationManifest.upsert({
      where: {
        jobId_id: { jobId: item.jobId, id: item.id }
      },
      update: {
        sourceId: item.sourceId,
        sourceParentId: item.sourceParentId,
        destParentId: item.destParentId,
        createdDestId: item.createdDestId,
        name: item.name,
        mimeType: item.mimeType,
        size: BigInt(item.size),
        originalId: item.originalId,
        originalMimeType: item.originalMimeType,
        status: item.status,
        isFolder: item.isFolder,
        depth: item.depth || 0,
        retryCount: item.retryCount || 0
      },
      create: {
        jobId: item.jobId,
        id: item.id,
        sourceId: item.sourceId,
        sourceParentId: item.sourceParentId,
        destParentId: item.destParentId,
        createdDestId: item.createdDestId,
        name: item.name,
        mimeType: item.mimeType,
        size: BigInt(item.size),
        originalId: item.originalId,
        originalMimeType: item.originalMimeType,
        status: item.status,
        isFolder: item.isFolder,
        depth: item.depth || 0,
        retryCount: item.retryCount || 0
      }
    });
  }

  public static async updateDestParentId(jobId: string, sourceParentId: string, destParentId: string) {
    await prisma.migrationManifest.updateMany({
      where: { jobId, sourceParentId },
      data: { destParentId }
    });
  }

  public static async updateItemStatus(jobId: string, id: string, status: ManifestItem['status']) {
    const row = await prisma.migrationManifest.findUnique({
      where: { jobId_id: { jobId, id } },
      select: { status: true }
    });
    if (!row) return;

    if (row.status === 'SUCCESS' || row.status === 'FAILED') {
       if (status !== 'SUCCESS' && status !== 'FAILED') {
          return;
       }
    }
    
    await prisma.migrationManifest.update({
      where: { jobId_id: { jobId, id } },
      data: { status }
    });
  }

  public static async incrementRetryCount(jobId: string, id: string): Promise<number> {
    const row = await prisma.migrationManifest.update({
      where: { jobId_id: { jobId, id } },
      data: { retryCount: { increment: 1 } },
      select: { retryCount: true }
    });
    return row.retryCount;
  }

  public static async getNextPendingItem(jobId: string): Promise<ManifestItem | null> {
    const row = await prisma.migrationManifest.findFirst({
      where: { jobId, status: 'PENDING', destParentId: { not: null } },
      orderBy: [
        { isFolder: 'desc' },
        { id: 'asc' }
      ]
    });
    if (!row) return null;
    return {
      ...row,
      size: Number(row.size)
    } as ManifestItem;
  }

  public static async updateCreatedDestId(jobId: string, id: string, createdDestId: string) {
    await prisma.migrationManifest.update({
      where: { jobId_id: { jobId, id } },
      data: { createdDestId }
    });
  }

  public static async getChildren(jobId: string, sourceParentId: string): Promise<ManifestItem[]> {
    const rows = await prisma.migrationManifest.findMany({
      where: { jobId, sourceParentId }
    });
    return rows.map(row => ({
      ...row,
      size: Number(row.size)
    })) as ManifestItem[];
  }

  public static async getPendingFoldersByDepth(jobId: string): Promise<ManifestItem[]> {
    const rows = await prisma.migrationManifest.findMany({
      where: { jobId, isFolder: true, status: 'PENDING' },
      orderBy: { depth: 'asc' }
    });
    return rows.map(row => ({
      ...row,
      size: Number(row.size)
    })) as ManifestItem[];
  }

  public static async getPendingFiles(jobId: string, limit: number): Promise<ManifestItem[]> {
    const rows = await prisma.migrationManifest.findMany({
      where: { jobId, isFolder: false, status: 'QUEUED' },
      orderBy: { depth: 'asc' },
      take: limit
    });
    return rows.map(row => ({
      ...row,
      size: Number(row.size)
    })) as ManifestItem[];
  }
}

