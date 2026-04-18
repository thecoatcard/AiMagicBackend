import Redis from 'ioredis';
import { loadSystemConfigFromDb } from './systemConfig.js';
import { loadModelConfigFromDb } from './modelConfig.js';
import { syncApiKeysWithDb } from './keyPool.js';
import { config } from '../config.js';

/**
 * Warm up a specific Redis instance by syncing state from MongoDB.
 * @param {string} url - Redis connection URL
 */
export async function warmupRedis(url) {
  if (!url) return;
  
  console.info(`[Sync] Warming up Redis: ${url.split('@').pop()}`); // Log only host part for security
  
  const tempClient = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    connectTimeout: 5000,
  });

  try {
    await Promise.all([
      loadSystemConfigFromDb(tempClient),
      loadModelConfigFromDb(tempClient),
      syncApiKeysWithDb(tempClient),
    ]);
    console.info(`[Sync] Warmup complete for ${url.split('@').pop()}`);
  } catch (err) {
    console.error(`[Sync] Failed to warmup ${url.split('@').pop()}:`, err.message);
  } finally {
    await tempClient.quit().catch(() => {});
  }
}

/**
 * Iterates through all configured Redis URLs (except maybe the current active one)
 * and ensures they are in sync with MongoDB.
 */
export async function syncAllBackups() {
  const urls = config.redisUrls;
  if (!urls || urls.length <= 1) return;

  console.info(`[Sync] Starting background sync for ${urls.length} instances...`);
  
  for (const url of urls) {
    // We warm up all of them to be safe, including active one (it's fast)
    await warmupRedis(url);
  }
}
