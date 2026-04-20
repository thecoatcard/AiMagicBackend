import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { config } from '../config.js';

let _client;
let _currentIndex = 0;
let _failoverPromise = null;      // Promise-based mutex: only one failover at a time
let _lastFailoverTime = 0;
const FAILOVER_COOLDOWN_MS = 30_000; // Prevent rapid failover loops
export const redisEvents = new EventEmitter();

/**
 * Get the currently active Redis instance.
 */
export function getRedis() {
  if (!_client) {
    _client = createClient(config.redisUrls[_currentIndex]);
  }
  return _client;
}

/**
 * Returns the URL of the currently active Redis.
 */
export function getActiveRedisUrl() {
  return config.redisUrls[_currentIndex] || null;
}

/**
 * Manually trigger a failover to the next Redis instance.
 * Uses a Promise-based mutex to prevent concurrent failover attempts.
 */
export async function switchToNextRedis() {
  if (config.redisUrls.length <= 1) {
    console.warn('[Redis] No backup Redis URLs configured for failover');
    return false;
  }

  // If a failover is already in progress, wait for it instead of starting another
  if (_failoverPromise) {
    return _failoverPromise;
  }

  // Enforce cooldown between switches
  const now = Date.now();
  if ((now - _lastFailoverTime) < FAILOVER_COOLDOWN_MS) {
    console.warn('[Redis] Failover skipped — cooldown active');
    return false;
  }

  _failoverPromise = (async () => {
    try {
      _lastFailoverTime = Date.now();
      const oldIndex = _currentIndex;
      _currentIndex = (_currentIndex + 1) % config.redisUrls.length;
      
      console.warn(`[Redis] Failing over: ${config.redisUrls[oldIndex]} -> ${config.redisUrls[_currentIndex]}`);

      if (_client) {
        _client.quit().catch(() => {});
      }
      
      _client = createClient(config.redisUrls[_currentIndex]);
      
      // Notify other services (Queue, Monitoring) to re-initialize
      redisEvents.emit('failover', { url: config.redisUrls[_currentIndex], index: _currentIndex });
      return true;
    } finally {
      _failoverPromise = null;
    }
  })();

  return _failoverPromise;
}

function createClient(url) {
  if (!url) {
    throw new Error('[Redis] No Redis URL provided to createClient');
  }

  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy(times) {
      // If we've tried 5 times and still failing, maybe trigger failover
      if (times > 5) {
        switchToNextRedis().catch(err => console.error('[Redis] Auto-failover failed:', err));
        return null; // Stop retrying this specific instance
      }
      return Math.min(times * 200, 10_000);
    },
    reconnectOnError(err) {
      const message = err.message.toLowerCase();
      // Detect common fatal errors that should trigger a failover
      if (
        message.includes('over_quota') || 
        message.includes('quota exceeded') ||
        message.includes('econnreset') ||
        message.includes('econnrefused')
      ) {
        console.error(`[Redis] Fatal error detected: ${err.message}. Triggering switch...`);
        switchToNextRedis().catch(swErr => console.error('[Redis] Failover trigger failed:', swErr));
        return false; // Don't reconnect on this instance
      }
      return true;
    },
  });

  client.on('error', (err) => {
    console.error('[Redis] connection error:', err.message);
    const msg = err.message.toLowerCase();
    if (msg.includes('econnreset') || msg.includes('econnrefused')) {
       switchToNextRedis().catch(() => {});
    }
  });

  client.on('connect', () => {
    console.info(`[Redis] connected to instance #${_currentIndex}`);
  });

  return client;
}
