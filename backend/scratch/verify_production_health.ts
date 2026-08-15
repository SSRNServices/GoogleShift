import https from 'https';
import http from 'http';

function checkHealth(url: string): Promise<any> {
  return new Promise((resolve) => {
    const getter = url.startsWith('https') ? https : http;
    const req = getter.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });
    req.on('error', (err) => resolve({ statusCode: 0, error: err.message }));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ statusCode: 0, error: 'Timeout' });
    });
  });
}

async function monitor() {
  console.log('Monitoring production health endpoint...');
  const res = await checkHealth('https://api.migration.ssrnservices.in/health');
  console.log('Health Endpoint Result:', JSON.stringify(res, null, 2));
}

monitor();
