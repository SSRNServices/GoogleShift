import { Request, Response } from 'express';
import { googleClientManager } from './google.client';
import { authService, ConnectionState } from './auth.service';
import { AccountType } from './token.store';

export class AuthController {
  
  public getAuthUrl = (req: Request, res: Response): void => {
    const type = req.params.type as AccountType;
    if (type !== 'source' && type !== 'destination') {
      res.status(400).send('Invalid account type');
      return;
    }
    const url = googleClientManager.getAuthUrl(type);
    res.redirect(url);
  };

  public handleCallback = async (req: Request, res: Response): Promise<void> => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const type = state as AccountType;
    
    if (!code || !state || (type !== 'source' && type !== 'destination')) {
      res.status(400).send('Invalid code or state');
      return;
    }

    try {
      await authService.handleCallback(req.sessionID, type, code);
      
      // Immediately retrieve Profile and Quota to verify token works
      const profileResponse = await authService.getProfile(req.sessionID, type);
      
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
  };

  public getProfile = async (req: Request, res: Response): Promise<void> => {
    const type = req.params.type as AccountType;
    try {
      const profileResponse = await authService.getProfile(req.sessionID, type);
      res.json(profileResponse);
    } catch (error) {
      console.error(`Unexpected server error fetching profile for ${type}:`, error);
      res.status(500).json({ state: ConnectionState.NOT_CONNECTED, error: 'Internal Server Error' });
    }
  };

  public logout = async (req: Request, res: Response): Promise<void> => {
    const type = req.params.type as AccountType;
    await authService.logout(req.sessionID, type);
    res.json({ success: true });
  };
}

export const authController = new AuthController();
