import { Router } from 'express';
import { prisma } from '../utils/database';
import { isRedisConnected } from '../utils/redis';
import dns from 'dns';
import { promisify } from 'util';

const router = Router();
const lookup = promisify(dns.lookup);

router.get('/', async (req, res) => {
  const startTime = Date.now();

  let dbConnected = false;
  let dbLatencyMs = 0;
  try {
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - dbStart;
    dbConnected = true;
  } catch (_) {
    dbConnected = false;
  }

  let googleApiReachable = false;
  try {
    await lookup('oauth2.googleapis.com');
    googleApiReachable = true;
  } catch (_) {
    googleApiReachable = false;
  }

  const redisStatus = {
    configured: !!process.env.REDIS_URL,
    connected: isRedisConnected()
  };

  const isHealthy = dbConnected;
  const status = isHealthy ? 'ok' : 'down';
  const statusCode = isHealthy ? 200 : 503;

  const mem = process.memoryUsage();

  res.status(statusCode).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    memory: {
      rss: `${Math.round(mem.rss / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)} MB`
    },
    database: {
      connected: dbConnected,
      latencyMs: dbLatencyMs
    },
    redis: redisStatus,
    googleApi: {
      reachable: googleApiReachable
    },
    responseTimeMs: Date.now() - startTime
  });
});

export default router;
