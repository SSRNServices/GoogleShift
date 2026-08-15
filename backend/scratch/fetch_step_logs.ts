import https from 'https';

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Node-Fetch',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    https.get(url, options, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function fetchLogs() {
  try {
    console.log('Fetching workflow run logs...');
    // Get job ID first
    const jobsUrl = 'https://api.github.com/repos/SSRNServices/GoogleShift/actions/runs/31874550508/jobs';
    const jobsDataStr = await fetchText(jobsUrl);
    const jobsData = JSON.parse(jobsDataStr);
    const jobId = jobsData.jobs[0].id;
    console.log(`Job ID: ${jobId}`);

    const logsUrl = `https://api.github.com/repos/SSRNServices/GoogleShift/actions/jobs/${jobId}/logs`;
    const logText = await fetchText(logsUrl);
    
    // Print last 100 lines of logText
    const lines = logText.split('\n');
    console.log(`Total log lines: ${lines.length}`);
    console.log('--- Last 120 Log Lines ---');
    console.log(lines.slice(-120).join('\n'));
  } catch (err: any) {
    console.error('Failed to fetch logs:', err.message);
  }
}

fetchLogs();
