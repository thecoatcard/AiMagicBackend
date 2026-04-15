import { getRedis } from '../redis/client.js';

/**
 * Returns true the first time this key is checked within the TTL window,
 * false if the alert was already sent recently (debounced).
 *
 * Uses SET key 1 EX ttl NX — atomic, no race conditions.
 *
 * @param {string} key   - unique alert identifier, e.g. 'alert:no_keys'
 * @param {number} ttlS  - debounce window in seconds
 */
export async function shouldSendAlert(key, ttlS) {
  try {
    const redis = getRedis();
    const result = await redis.set(key, '1', 'EX', ttlS, 'NX');
    return result === 'OK'; // OK = first time in window; null = already throttled
  } catch {
    return true; // redis error → allow send so we don't silently lose alerts
  }
}

/**
 * Clears the throttle for a key, allowing the next alert to fire immediately.
 * Use this when the condition is resolved (e.g. keys came back online).
 */
export async function clearAlertThrottle(key) {
  try {
    await getRedis().del(key);
  } catch {
    // ignore
  }
}
