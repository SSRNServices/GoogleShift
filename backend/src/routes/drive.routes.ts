import { Router } from 'express';
import { driveService } from '../services/DriveService';
import { AccountType } from '../oauth/OAuthService';

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

router.get('/:type/root', async (req, res) => {
  const type = req.params.type as AccountType;
  const pageToken = req.query.pageToken as string | undefined;

  try {
    const data = await driveService.getRoot(type, pageToken);
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
    const data = await driveService.getFolderContents(type, folderId, pageToken);
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
    const data = await driveService.getFolderInfo(type, folderId);
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
    const data = await driveService.search(type, query, pageToken);
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
    const data = await driveService.getSharedWithMe(type, pageToken);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch shared files' });
  }
});

router.get('/:type/recent', async (req, res) => {
  const type = req.params.type as AccountType;
  const pageToken = req.query.pageToken as string | undefined;

  try {
    const data = await driveService.getRecent(type, pageToken);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch recent files' });
  }
});

router.get('/:type/starred', async (req, res) => {
  const type = req.params.type as AccountType;
  const pageToken = req.query.pageToken as string | undefined;

  try {
    const data = await driveService.getStarred(type, pageToken);
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
    const data = await driveService.createFolder(type, name, parentId);
    res.json(data);
  } catch (error: any) {
    console.error('Error creating folder:', error.message);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

export default router;
