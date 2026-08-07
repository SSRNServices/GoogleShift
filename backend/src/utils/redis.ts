import Redis from 'ioredis';
import { logger } from './logger';

let redisClient: Redis | null = null;
let isRedisAvailable = false;

export function initRedis(): Redis | null {
  const redisUrl = process.env.REDIS_URL;
  
  if (!redisUrl) {
    logger.info('[Redis] REDIS_URL not configured. Redis caching/session features disabled.');
    return null;
  }

  try {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      retryStrategy(times) {
        const delay = Math.min(times * 200, 2000);
        logger.warn(`[Redis] Connection attempt ${times} failed. Retrying in ${delay}ms...`);
        return delay;
      }
    });

    redisClient.on('connect', () => {
      isRedisAvailable = true;
      logger.info('✓ [Redis] Connected successfully');
    });

    redisClient.on('error', (err) => {
      isRedisAvailable = false;
      logger.error(`❌ [Redis] Connection error: ${err.message}`);
    });

    redisClient.on('end', () => {
      isRedisAvailable = false;
      logger.info('[Redis] Connection closed');
    });

    return redisClient;
  } catch (err: any) {
    logger.error(`❌ [Redis] Initialization failed: ${err.message}`);
    return null;
  }
}

export function getRedisClient(): Redis | null {
  return redisClient;
}

export function isRedisConnected(): boolean {
  return isRedisAvailable && redisClient !== null && redisClient.status === 'ready';
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    logger.info('[Redis] Closing connection...');
    await redisClient.quit().catch(() => {});
    redisClient = null;
    isRedisAvailable = false;
  }
}
