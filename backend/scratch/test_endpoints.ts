import https from 'https';
import http from 'http';

function checkUrl(url: string): Promise<any> {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ url, statusCode: res.statusCode, bodySnippet: data.substring(0, 200) }));
    }).on('error', (err) => resolve({ url, error: err.message }));
  });
}

async function testAll() {
  const urls = [
    'https://api.migration.ssrnservices.in/health',
    'https://api.migration.ssrnservices.in/api/health',
    'https://api.migration.ssrnservices.in/api/v1/health',
    'https://migration.ssrnservices.in/api/health',
    'https://migration.ssrnservices.in/api/v1/health'
  ];

  for (const url of urls) {
    const res = await checkUrl(url);
    console.log(JSON.stringify(res, null, 2));
  }
}

testAll();
