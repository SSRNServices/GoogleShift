import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import rateLimit from 'express-rate-limit';

import { validateConfig } from './config/config';
import { logger, requestTracingMiddleware } from './utils/logger';
import { globalErrorHandler } from './utils/errorHandler';
import { setupSwagger } from './utils/swagger';
import { initRedis, closeRedis } from './utils/redis';

// Validate Configuration on boot - fail fast if missing
const config = validateConfig();

import adminRoutes from './routes/admin.routes';
import authRoutes from './auth/auth.routes';
import { sessionMiddleware } from './auth/session';
import { requireUserAuth } from './auth/auth.middleware';
import { configurePassport } from './auth/passport';
import { configureLocalStrategy } from './auth/local.strategy';
import driveRoutes from './routes/drive.routes';
import migrationRoutes from './routes/migration.routes';
import authAdminRoutes from './routes/auth.admin.routes';
import discoveryRoutes from './routes/discovery.routes';
import sessionRoutes from './routes/session.routes';
import healthRoutes from './routes/health.routes';
import photosRoutes from './routes/photos.routes';
import { workerWatchdog } from './transfer/WorkerWatchdog';
import dns from 'dns';
import { promisify } from 'util';
import { prisma, pool, validateDatabaseSchema, performWriteDiagnostics, getDatabaseConnectionInfo } from './utils/database';

import { StorageInitializer } from './utils/storage/StorageInitializer';

const dnsLookup = promisify(dns.lookup);

async function bootstrap() {
  logger.info('=== Starting GoogleShift Backend ===');
  logger.info(`Environment: ${config.NODE_ENV}`);
  logger.info(`Node version: ${process.version}`);
  logger.info(`Listening address: 0.0.0.0:${config.PORT}`);

  // 1. Initialize Redis (if configured)
  initRedis();

  // 2. Configure Passport Strategies
  configurePassport();
  configureLocalStrategy();

  // 3. Initialize Express Application
  const app = express();

  // Security Headers & Proxy Setup (Trust first proxy hop for Nginx)
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: config.NODE_ENV === 'production' ? undefined : false,
    crossOriginEmbedderPolicy: false
  }));

  // Gzip Compression & Payload Limits
  app.use(compression());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));
  app.use(cookieParser());

  // Global Rate Limiting
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: config.NODE_ENV === 'production' ? 1000 : 5000,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
    message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later.' } }
  });
  app.use(globalLimiter);

  // CORS Configuration
  const defaultOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'https://googleshift.com',
    'https://www.googleshift.com',
    'https://app.googleshift.com',
    'https://migration.ssrnservices.in'
  ];

  if (config.FRONTEND_URL) {
    config.FRONTEND_URL.split(',').forEach((url) => {
      const trimmed = url.trim();
      if (trimmed && !defaultOrigins.includes(trimmed)) {
        defaultOrigins.push(trimmed);
      }
    });
  }

  if (config.CORS_ORIGIN) {
    config.CORS_ORIGIN.split(',').forEach((url) => {
      const trimmed = url.trim();
      if (trimmed && !defaultOrigins.includes(trimmed)) {
        defaultOrigins.push(trimmed);
      }
    });
  }

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || defaultOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn(`[CORS] Blocked request from origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true
  }));

  // Request Tracing & Structured Logging
  app.use(requestTracingMiddleware);

  // Session & Auth Middleware
  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());

  // Setup Swagger Documentation (Development only)
  setupSwagger(app);

  // Health Endpoints
  app.use('/health', healthRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/v1/health', healthRoutes);

  // Root Status Endpoint
  app.get('/', (_req, res) => {
    res.json({
      service: 'GoogleShift Backend',
      status: 'online',
      version: '1.0.0',
      environment: config.NODE_ENV
    });
  });

  // Mount Application Routes (with /api/v1 prefix & backward compatible aliases)
  const mountRoutes = (prefix: string) => {
    app.use(`${prefix}/auth`, authRoutes);
    app.use(`${prefix}/api/admin/auth`, authAdminRoutes);
    app.use(`${prefix}/api/admin`, adminRoutes);
    app.use(`${prefix}/api/drive`, requireUserAuth, driveRoutes);
    app.use(`${prefix}/api/migrations`, requireUserAuth, migrationRoutes);
    app.use(`${prefix}/api/migration/session`, requireUserAuth, sessionRoutes);
    app.use(`${prefix}/api/discovery`, requireUserAuth, discoveryRoutes);
    app.use(`${prefix}/api/photos`, photosRoutes);
  };

  // Mount API v1 Routes
  mountRoutes('/api/v1');

  // Legacy root mount for backwards compatibility
  app.use('/auth', authRoutes);
  app.use('/api/admin/auth', authAdminRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/drive', requireUserAuth, driveRoutes);
  app.use('/api/migrations', requireUserAuth, migrationRoutes);
  app.use('/api/migration/session', requireUserAuth, sessionRoutes);
  app.use('/api/discovery', requireUserAuth, discoveryRoutes);
  app.use('/api/photos', photosRoutes);

  // Global Error Handler
  app.use(globalErrorHandler);

  // Start HTTP Server IMMEDIATELY to respond to health checks
  const server = app.listen(config.PORT, '0.0.0.0', () => {
    logger.info('====================================');
    logger.info(`GoogleShift Backend is running!`);
    logger.info(`Listening on http://0.0.0.0:${config.PORT}`);
    logger.info(`Health check: http://0.0.0.0:${config.PORT}/health`);
    if (config.NODE_ENV !== 'production') {
      logger.info(`Swagger docs: http://0.0.0.0:${config.PORT}/docs`);
    }
    logger.info('====================================');

  });

  // Asynchronous Background Initialization Tasks
  (async () => {
    try {
      // 0. Storage Provider Initialization & Diagnostics Check
      await StorageInitializer.initializeStorage();

      // 1. Environment & Database Diagnostic Check
      const dbInfo = getDatabaseConnectionInfo();
      logger.info('--- Database Diagnostic Check ---');
      logger.info(`✓ Variable Used: ${dbInfo.variableName || 'DATABASE_URL'}`);
      logger.info(`✓ Connection Mode: ${dbInfo.isPooler ? 'Transaction Pooler (6543)' : 'Session / Direct (5432)'}`);
      logger.info(`✓ Target Host: ${dbInfo.host}`);
      logger.info(`✓ Target Port: ${dbInfo.port}`);
      logger.info(`✓ Target Database: ${dbInfo.database}`);
      logger.info(`✓ SSL Mode: ${dbInfo.sslMode}`);
      logger.info(`✓ Masked Connection String: ${dbInfo.maskedUrl}`);
      logger.info('---------------------------------');

      // 2. Test DNS Resolution
      if (dbInfo.host && dbInfo.host !== 'unknown' && !dbInfo.host.startsWith('127.') && dbInfo.host !== 'localhost') {
        try {
          const dnsResult = await dnsLookup(dbInfo.host);
          logger.info(`✓ DNS Resolution Passed: ${dbInfo.host} -> ${dnsResult.address}`);
        } catch (dnsErr: any) {
          logger.warn(`⚠️ [DNS Check Warning] Could not resolve host '${dbInfo.host}': ${dnsErr.message}`);
        }
      }

      // 3. Database connection check & schema validation (with Exponential Backoff Retry)
      const MAX_DB_RETRIES = 5;
      let dbConnected = false;

      for (let attempt = 1; attempt <= MAX_DB_RETRIES; attempt++) {
        try {
          const start = Date.now();
          await prisma.$queryRaw`SELECT 1`;
          const pingMs = Date.now() - start;
          logger.info(`✓ Database Connected (Ping: ${pingMs}ms, Attempt ${attempt}/${MAX_DB_RETRIES})`);

          await performWriteDiagnostics();
          await validateDatabaseSchema();
          dbConnected = true;
          break;
        } catch (err: any) {
          const delayMs = Math.pow(2, attempt) * 1000;
          logger.warn(`⚠️ [Database Attempt ${attempt}/${MAX_DB_RETRIES} Failed] Code: ${err.code || 'UNKNOWN'}, Message: ${err.message}`);
          if (attempt < MAX_DB_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }

      if (dbConnected) {
        logger.info('[BACKEND_RESTART] Database connected. Initializing WorkerWatchdog and active job recovery check...');
        workerWatchdog.start();
        logger.info('[WorkerWatchdog] Monitoring COPYING/PREPARING jobs every 60s.');
      } else {
        logger.warn('⚠️ [Database Notice] Connection retries exhausted. Background reconnect active.');
      }
    } catch (bgErr: any) {
      logger.error(`⚠️ Async initialization error: ${bgErr.message}`);
    }
  })();

  // Graceful Shutdown Logic
  const gracefulShutdown = async (signal: string) => {
    logger.info(`\n[Shutdown] Received ${signal}. Starting graceful shutdown...`);

    // 1. Stop receiving new HTTP requests
    server.close(async () => {
      logger.info('[Shutdown] HTTP server closed.');

      try {
        // 2. Stop Worker Watchdog
        workerWatchdog.stop();
        logger.info('[Shutdown] Worker Watchdog stopped.');

        // 3. Close Redis Connection
        await closeRedis();

        // 4. Close Database Pool & Disconnect Prisma
        await prisma.$disconnect();
        await pool.end();
        logger.info('[Shutdown] Database connections closed.');

        logger.info('✓ Graceful shutdown completed cleanly.');
        process.exit(0);
      } catch (err: any) {
        logger.error(`❌ Error during shutdown: ${err.message}`);
        process.exit(1);
      }
    });

    // Force exit after 10 seconds timeout
    setTimeout(() => {
      logger.error('❌ Shutdown timed out after 10s. Forcing exit.');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('[FATAL] Uncaught Exception:', err);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('[FATAL] Unhandled Promise Rejection:', reason);
  });
}

bootstrap();
