import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.routes';
import driveRoutes from './routes/drive.routes';
import migrationRoutes from './routes/migration.routes';

dotenv.config();

console.log('\n=== Application Startup ===');
console.log(`GOOGLE_CLIENT_ID: ${process.env.GOOGLE_CLIENT_ID ? 'Loaded (starts with ' + process.env.GOOGLE_CLIENT_ID.substring(0, 15) + '...)' : 'MISSING'}`);
console.log(`GOOGLE_REDIRECT_URI: ${process.env.GOOGLE_REDIRECT_URI || 'MISSING (Defaults to http://localhost:3000/api/auth/callback)'}`);
console.log('===========================\n');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'CloudShift Backend is running' });
});

app.use('/auth', authRoutes);
app.use('/api/drive', driveRoutes);
app.use('/api/migrations', migrationRoutes);

// Print all registered routes
const printRoutes = () => {
  console.log('\n=== Registered Routes ===');
  console.log('GET /api/health');
  console.log('GET /auth/source');
  console.log('GET /auth/destination');
  console.log('GET /auth/google/callback');
  console.log('GET /auth/source/profile');
  console.log('GET /auth/destination/profile');
  console.log('POST /auth/source/logout');
  console.log('POST /auth/destination/logout');
  console.log('GET /api/drive/:type/folder/:id');
  console.log('GET /api/drive/:type/search');
  console.log('POST /api/drive/destination/create-folder');
  console.log('=========================\n');
};

const runDiagnostics = async () => {
  console.log('\n=== Network Diagnostics ===');
  try {
    const dns = await import('dns');
    const { promisify } = await import('util');
    const lookup = promisify(dns.lookup);
    
    console.log('Checking DNS resolution for oauth2.googleapis.com...');
    const result = await lookup('oauth2.googleapis.com');
    console.log(`[OK] Resolved oauth2.googleapis.com to ${result.address}`);
    console.log('[OK] Internet connectivity verified.');
  } catch (error: any) {
    console.error(`[FAIL] DNS resolution failed: ${error.message}`);
    console.error('[FAIL] Network might be unreachable or DNS is failing.');
  }
  console.log('===========================\n');
};

import { queueService } from './services/QueueService';

app.listen(port, async () => {
  console.log(`[server]: Server is running at http://localhost:${port}`);
  printRoutes();
  await runDiagnostics();
  
  queueService.init();
});
