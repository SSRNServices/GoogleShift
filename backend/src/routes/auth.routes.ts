import { Router } from 'express';
import { oauthService, AccountType, ConnectionState } from '../oauth/OAuthService';

const router = Router();

router.get('/:type', (req, res) => {
  const type = req.params.type as AccountType;
  if (type !== 'source' && type !== 'destination') {
    res.status(400).send('Invalid account type');
    return;
  }
  const url = oauthService.getAuthUrl(type);
  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  const code = req.query.code as string;
  const state = req.query.state as string;
  const type = state as AccountType;
  
  if (!code || !state || (type !== 'source' && type !== 'destination')) {
    res.status(400).send('Invalid code or state');
    return;
  }

  try {
    await oauthService.handleCallback(type, code);
    
    // Immediately retrieve Profile and Quota to verify token works
    const profileResponse = await oauthService.getProfile(type);
    
    console.log(`\n=== OAuth Success for ${type} ===`);
    console.log(`Name: ${profileResponse.profile?.name}`);
    console.log(`Email: ${profileResponse.profile?.email}`);
    console.log(`Storage Used: ${profileResponse.profile?.storage.used}`);
    console.log(`Storage Limit: ${profileResponse.profile?.storage.limit}`);
    console.log('=================================\n');

    // Redirect back to frontend
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}?connected=${type}`);
  } catch (error: any) {
    console.error(`Error during ${type} callback:`, error);
    if (error.name === 'NetworkError') {
      res.status(502).send("Unable to reach Google's OAuth servers. Please check your internet connection or try again.");
    } else {
      res.status(500).send("Authentication failed");
    }
  }
});

router.get('/:type/profile', async (req, res) => {
  const type = req.params.type as AccountType;
  try {
    const profileResponse = await oauthService.getProfile(type);
    // Always return HTTP 200 for expected auth states
    res.json(profileResponse);
  } catch (error) {
    console.error(`Unexpected server error fetching profile for ${type}:`, error);
    res.status(500).json({ state: ConnectionState.NOT_CONNECTED, error: 'Internal Server Error' });
  }
});

router.post('/:type/logout', (req, res) => {
  const type = req.params.type as AccountType;
  oauthService.logout(type);
  res.json({ success: true });
});

export default router;
