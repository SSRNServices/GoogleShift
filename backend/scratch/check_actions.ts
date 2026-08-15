import https from 'https';

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json'
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function checkRunJobs() {
  try {
    const data = await fetchJson('https://api.github.com/repos/SSRNServices/GoogleShift/actions/runs/31877547247/jobs');
    if (data.jobs) {
      for (const job of data.jobs) {
        console.log(`Job: "${job.name}" | Status: ${job.status} | Conclusion: ${job.conclusion}`);
        if (job.steps) {
          for (const step of job.steps) {
            console.log(`  - Step ${step.number}: "${step.name}" | Status: ${step.status} | Conclusion: ${step.conclusion}`);
          }
        }
      }
    }
  } catch (err: any) {
    console.error('Failed to fetch job steps:', err.message);
  }
}

checkRunJobs();
