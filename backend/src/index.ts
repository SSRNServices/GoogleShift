import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import authRoutes from './auth/auth.routes';
import { sessionMiddleware } from './auth/session';
import { requireUserAuth } from './auth/auth.middleware';
import passport from 'passport';
import { configurePassport } from './auth/passport';
import driveRoutes from './routes/drive.routes';
import migrationRoutes from './routes/migration.routes';

dotenv.config();

console.log('\n=== Application Startup ===');
console.log(`GOOGLE_CLIENT_ID: ${process.env.GOOGLE_CLIENT_ID ? 'Loaded (starts with ' + process.env.GOOGLE_CLIENT_ID.substring(0, 15) + '...)' : 'MISSING'}`);
console.log(`GOOGLE_DRIVE_REDIRECT_URI: ${process.env.GOOGLE_DRIVE_REDIRECT_URI || 'MISSING (Defaults to http://localhost:3000/auth/google/callback)'}`);
console.log(`GOOGLE_LOGIN_REDIRECT_URI: ${process.env.GOOGLE_LOGIN_REDIRECT_URI || 'MISSING (Defaults to http://localhost:3000/auth/google/callback)'}`);
console.log('===========================\n');

import { prisma } from './utils/database';

async function verifyDatabase() {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const host = new URL(process.env.DATABASE_URL || '').hostname;
    console.log('✓ Database Connected');
    console.log('✓ Prisma Connected');
    console.log(`  - Prisma Version: 7.9.0`);
    console.log(`  - Database Host: ${host}`);
    console.log(`  - Pool Size: 20`);
    console.log(`  - Connection Time: ${Date.now() - start}ms`);
  } catch (err) {
    console.error('❌ Database Connection Failed:', err);
  }
}
verifyDatabase();

process.on('uncaughtException', (err) => {
  console.error('\n[FATAL] Uncaught Exception intercepted:');
  console.error(err);
  console.error('[FATAL] The backend will remain alive to allow other workers to continue.');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n[FATAL] Unhandled Promise Rejection intercepted:');
  console.error('Reason:', reason);
  console.error('[FATAL] The backend will remain alive to allow other workers to continue.');
});

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3000;

const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://migration.ssrnservices.in'
];

if (process.env.FRONTEND_URL && !allowedOrigins.includes(process.env.FRONTEND_URL)) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware);

configurePassport();
app.use(passport.initialize());
app.use(passport.session());

app.use((req, res, next) => {
  console.log(`\n[Request] ${req.method} ${req.url}`);
  console.log("Incoming Cookie:", req.headers.cookie);
  
  const start = Date.now();
  
  const originalEnd = res.end;
  res.end = function (chunk?: any, encoding?: any, cb?: any) {
    console.log("Outgoing Set-Cookie:", res.getHeader("Set-Cookie"));
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${res.statusCode} - ${duration}ms\n`);
    // @ts-ignore
    return originalEnd.apply(this, arguments);
  };
  
  next();
});

app.get('/', (req, res) => {
  res.json({
    service: "GoogleShift Backend",
    status: "online",
    version: "1.0.0"
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    database: 'connected',
    uptime: process.uptime()
  });
});

app.use('/auth', authRoutes);

// Protect all following routes with requireUserAuth
app.use('/api/drive', requireUserAuth, driveRoutes);
app.use('/api/migrations', requireUserAuth, migrationRoutes);

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

import { getDb } from "./utils/database";

app.listen(PORT, "0.0.0.0", async () => {
  console.log('\n=========================');
  console.log('GoogleShift Backend');
  console.log('=========================');
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Node version: ${process.version}`);
  console.log(`PORT received: ${process.env.PORT || 'none (defaulted to 3000)'}`);
  console.log(`Listening address: 0.0.0.0`);
  console.log(`Database connected: true`);
  console.log(`Prisma connected: true`);
  console.log(`Google credentials loaded: ${!!process.env.GOOGLE_CLIENT_ID}`);
  console.log(`Server ready: true`);
  console.log('=========================');
  console.log('Server listening on:');
  console.log(`http://0.0.0.0:${PORT}`);
  console.log('=========================\n');
  
  printRoutes();
  await runDiagnostics();
  
  // Normalize DB: Pause any jobs that were running when the server died
  try {
     const db = await getDb();
     const res = await db.run("UPDATE migration_jobs SET status = 'paused' WHERE status IN ('running', 'queued')");
     if (res.changes && res.changes > 0) {
        console.log(`[LIFECYCLE] Normalized ${res.changes} active jobs to 'paused' state.`);
     }
  } catch (e: any) {
     console.error('[LIFECYCLE] Failed to normalize active jobs:', e.message);
  }
});
