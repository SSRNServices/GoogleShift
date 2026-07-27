// @ts-nocheck
import { Router } from 'express';
import { driveService } from '../services/DriveService';
import { AccountType } from '../auth/token.store';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();

// Middleware to parse type parameter
router.use('/:type', (req, res, next) => {
  const type = req.params.type as AccountType;
  if (type !== 'source' && type !== 'destination') {
    res.status(400).json({ error: 'Invalid account type' });
    return;
  }
  next();
});

// Protect all drive routes
router.use('/:type', requireAuth());

import { DiscoveryService } from '../services/DiscoveryService';

router.get('/:type/summary', async (req, res) => {
  const type = req.params.type as AccountType;
  const itemsParam = req.query.items as string;

  console.log(`[DriveRoutes] /${type}/summary requested. Items:`, itemsParam);

  if (!itemsParam) {
    res.status(400).json({ error: 'Missing items parameter' });
    return;
  }

  const items = itemsParam.split(',').map(part => {
    const [id, itemType] = part.split(':');
    return { id, isFolder: itemType === 'folder' };
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  if (res.flushHeaders) {
    res.flushHeaders();
  }
  
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  const manifestId = 'manifest_scan_' + Date.now();

  const onProgress = (event: string, data: any) => {
    res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
  };

  try {
    const summary = await DiscoveryService.executeDiscovery({
      userId: (req as any).user.id,
      type,
      items,
      manifestId,
      onProgress
    });
    console.log(`[DriveRoutes] Scan complete for ${manifestId}.`);
    // The final result is already sent via SCAN_COMPLETED, but we can emit a close event
    res.write(`data: ${JSON.stringify({ event: 'CLOSE' })}\n\n`);
  } catch (error: any) {
    console.error(`[DriveRoutes] Error calculating summary for ${type}:`, error.message);
    res.write(`data: ${JSON.stringify({ event: 'ERROR', data: { message: error.message } })}\n\n`);
  } finally {
    res.end();
  }
});

router.get('/:type/root', async (req, res) => {
  const type = req.params.type as AccountType;
  const pageToken = req.query.pageToken as string | undefined;

  try {
    const data = await driveService.getRoot((req as any).user.id, type, pageToken);
    res.json(data);
  } catch (error: any) {
    console.error(`Error fetching root for ${type}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch root folder contents' });
  }
});

router.get('/:type/folder/:id', async (req, res) => {
  const type = req.params.type as AccountType;
  const folderId = req.params.id;
  const pageToken = req.query.pageToken as string | undefined;

  try {
    const data = await driveService.getFolderContents((req as any).user.id, type, folderId, pageToken);
    res.json(data);
  } catch (error: any) {
    console.error(`Error fetching folder ${folderId}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch folder contents' });
  }
});

router.get('/:type/folder-info/:id', async (req, res) => {
  const type = req.params.type as AccountType;
  const folderId = req.params.id;

  try {
    const data = await driveService.getFolderInfo((req as any).user.id, type, folderId);
    res.json(data);
  } catch (error: any) {
    console.error(`Error fetching folder info ${folderId}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch folder info' });
  }
});

router.get('/:type/search', async (req, res) => {
  const type = req.params.type as AccountType;
  const query = req.query.q as string;
  const pageToken = req.query.pageToken as string | undefined;

  if (!query) {
    res.status(400).json({ error: 'Missing query parameter' });
    return;
  }

  try {
    const data = await driveService.search((req as any).user.id, type, query, pageToken);
    res.json(data);
  } catch (error: any) {
    console.error('Error searching drive:', error.message);
    res.status(500).json({ error: 'Failed to search drive' });
  }
});

router.get('/:type/shared', async (req, res) => {
  const type = req.params.type as AccountType;
  const pageToken = req.query.pageToken as string | undefined;

  try {
    const data = await driveService.getSharedWithMe((req as any).user.id, type, pageToken);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch shared files' });
  }
});

router.get('/:type/recent', async (req, res) => {
  const type = req.params.type as AccountType;
  const pageToken = req.query.pageToken as string | undefined;

  try {
    const data = await driveService.getRecent((req as any).user.id, type, pageToken);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch recent files' });
  }
});

router.get('/:type/starred', async (req, res) => {
  const type = req.params.type as AccountType;
  const pageToken = req.query.pageToken as string | undefined;

  try {
    const data = await driveService.getStarred((req as any).user.id, type, pageToken);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch starred files' });
  }
});

router.post('/:type/create-folder', async (req, res) => {
  const type = req.params.type as AccountType;
  const { name, parentId } = req.body;

  if (type !== 'destination') {
    res.status(403).json({ error: 'Creating folders is only allowed on the destination account' });
    return;
  }

  if (!name) {
    res.status(400).json({ error: 'Folder name is required' });
    return;
  }

  try {
    const data = await driveService.createFolder((req as any).user.id, type, name, parentId);
    res.json(data);
  } catch (error: any) {
    console.error('Error creating folder:', error.message);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

export default router;
