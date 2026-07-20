import https from 'https';

export class NetworkHeartbeat {
  public static async isOnline(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = https.get('https://oauth2.googleapis.com', { timeout: 3000 }, (res) => {
        resolve(res.statusCode === 200 || res.statusCode === 404); // Even a 404 means DNS and routing works
      });
      
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  public static async waitForOnline(onCheck: (online: boolean) => void, interval = 5000): Promise<void> {
    while (true) {
      const online = await this.isOnline();
      onCheck(online);
      if (online) return;
      await new Promise(res => setTimeout(res, interval));
    }
  }
}
