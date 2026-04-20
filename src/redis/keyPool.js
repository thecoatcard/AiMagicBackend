import { getRedis } from './client.js';
import { config } from '../config.js';
import { notifyAdminKeyPoolLow } from '../services/notifications.js';
import { upsertApiKey, removeApiKey as removeKeyFromDb, getAllApiKeys } from '../db/apiKeys.js';

const KEY_POOL_LOW_THRESHOLD = parseInt(process.env.KEY_POOL_LOW_THRESHOLD || '5', 10);

const ACTIVE_LIST = 'gemini_keys';
const COOLDOWN_ZSET = 'gemini_keys_cooldown';
// Score used to permanently disable a key (year 9999)
const DISABLED_SCORE = 253402300799000;

/**
 * Pop a key from the active pool (RPOP).
 * Returns null if no keys are available.
 */
export async function getKey() {
  return getRedis().rpop(ACTIVE_LIST);
}

/**
 * Return a key to the front of the active pool (LPUSH).
 * Duplicate-safe: only adds if not already present.
 */
export async function returnKey(key) {
  const redis = getRedis();
  const luaScript = `
    local exists = redis.call('LPOS', KEYS[1], ARGV[1])
    if exists == false then
      redis.call('LPUSH', KEYS[1], ARGV[1])
      return 1
    end
    return 0
  `;
  await redis.eval(luaScript, 1, ACTIVE_LIST, key);
}

/**
 * Move a key to the cooldown ZSET with an expiry timestamp.
 * @param {string} key
 * @param {number} ttlMs - duration in ms (use DISABLED_SCORE for permanent disable)
 */
export async function cooldownKey(key, ttlMs) {
  const expireAt = Date.now() + ttlMs;
  const redis = getRedis();
  await redis.lrem(ACTIVE_LIST, 0, key);
  await redis.zadd(COOLDOWN_ZSET, expireAt, key);
  
  // Sync to MongoDB
  await upsertApiKey(key, { status: 'cooldown', cooldownUntil: new Date(expireAt) });
  
  checkPoolLow(redis).catch(() => {});
}

/**
 * Permanently disable a key (moves to cooldown with far-future score).
 */
export async function disableKey(key) {
  const redis = getRedis();
  const rawKey = await resolveRawKey(key);
  if (!rawKey) return; // Key not found in any pool
  await redis.lrem(ACTIVE_LIST, 0, rawKey);
  await redis.zadd(COOLDOWN_ZSET, DISABLED_SCORE, rawKey);
  
  // Sync to MongoDB
  await upsertApiKey(rawKey, { status: 'disabled' });
  
  checkPoolLow(redis).catch(() => {});
}

async function checkPoolLow(redis) {
  const activeCount = await redis.llen(ACTIVE_LIST);
  if (activeCount <= KEY_POOL_LOW_THRESHOLD) {
    notifyAdminKeyPoolLow({ activeCount, threshold: KEY_POOL_LOW_THRESHOLD });
  }
}

/**
 * Re-enable a disabled/cooled-down key — moves it back to the active pool.
 */
export async function enableKey(key) {
  const redis = getRedis();
  const rawKey = await resolveRawKey(key);
  if (!rawKey) return; // Key not found in any pool
  await redis.zrem(COOLDOWN_ZSET, rawKey);
  await redis.lpush(ACTIVE_LIST, rawKey);
  
  // Sync to MongoDB
  await upsertApiKey(rawKey, { status: 'active' });
}

/**
 * Add a new key to the active pool (only if not already present).
 * Uses a Lua script to make the check-and-insert atomic.
 */
export async function addKey(key) {
  const redis = getRedis();

  // Atomic: check both active list and cooldown ZSET, then push if absent
  const luaScript = `
    local active = redis.call('LPOS', KEYS[1], ARGV[1])
    if active ~= false then return 1 end
    local cooldown = redis.call('ZSCORE', KEYS[2], ARGV[1])
    if cooldown ~= false then return 2 end
    redis.call('RPUSH', KEYS[1], ARGV[1])
    return 0
  `;

  const result = await redis.eval(luaScript, 2, ACTIVE_LIST, COOLDOWN_ZSET, key);

  if (result === 1) return { added: false, reason: 'already_active' };
  if (result === 2) return { added: false, reason: 'in_cooldown' };
  
  // Sync to MongoDB
  await upsertApiKey(key, { status: 'active' });
  
  return { added: true };
}

/**
 * Remove a key from all Redis lists and MongoDB.
 */
export async function removeKey(key) {
  const redis = getRedis();
  await Promise.all([
    redis.lrem(ACTIVE_LIST, 0, key),
    redis.zrem(COOLDOWN_ZSET, key),
    removeKeyFromDb(key)
  ]);
  return { removed: true };
}

/**
 * Move expired cooldown keys back to the active pool.
 * Called on a background interval.
 */
export async function restoreExpiredKeys() {
  const redis = getRedis();
  const now = Date.now();

  // Atomic Lua: ZRANGEBYSCORE + ZREM + LPUSH in one shot to avoid
  // the TOCTOU window where the same key gets restored twice by two callers.
  const luaScript = `
    local keys = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
    if #keys == 0 then return 0 end
    for _, k in ipairs(keys) do
      redis.call('ZREM', KEYS[1], k)
      redis.call('LPUSH', KEYS[2], k)
    end
    return #keys
  `;

  await redis.eval(luaScript, 2, COOLDOWN_ZSET, ACTIVE_LIST, now);
}

/**
 * List all keys: active (masked) + cooldown with remaining TTL.
 */
export async function listKeys() {
  const redis = getRedis();
  const now = Date.now();

  const [activeKeys, cooldownEntries] = await Promise.all([
    redis.lrange(ACTIVE_LIST, 0, -1),
    redis.zrangebyscore(COOLDOWN_ZSET, '-inf', '+inf', 'WITHSCORES'),
  ]);

  const active = activeKeys.map(k => ({
    key: maskKey(k),
    status: 'active',
  }));

  const cooldown = [];
  for (let i = 0; i < cooldownEntries.length; i += 2) {
    const k = cooldownEntries[i];
    const score = parseInt(cooldownEntries[i + 1], 10);
    const permanent = score === DISABLED_SCORE;
    cooldown.push({
      key: maskKey(k),
      status: permanent ? 'disabled' : 'cooldown',
      cooldownRemainingMs: permanent ? null : Math.max(0, score - now),
    });
  }

  return { active, cooldown };
}

/**
 * Clear all temporary cooldowns, restoring those keys to the active pool.
 * Permanently disabled keys (DISABLED_SCORE) are left untouched.
 * @returns {number} number of keys restored
 */
export async function clearAllCooldowns() {
  const redis = getRedis();

  // Restore only keys with score < DISABLED_SCORE (i.e. temporary cooldowns)
  const luaScript = `
    local keys = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
    if #keys == 0 then return 0 end
    for _, k in ipairs(keys) do
      redis.call('ZREM', KEYS[1], k)
      redis.call('LPUSH', KEYS[2], k)
    end
    return #keys
  `;
  const maxScore = String(DISABLED_SCORE - 1);
  return redis.eval(luaScript, 2, COOLDOWN_ZSET, ACTIVE_LIST, maxScore);
}

/**
 * Get current key pool statistics broken down by state.
 * @returns {{ active: number, cooldown: number, disabled: number, total: number }}
 */
export async function getPoolStats() {
  const redis = getRedis();

  const [activeCount, cooldownEntries] = await Promise.all([
    redis.llen(ACTIVE_LIST),
    redis.zrangebyscore(COOLDOWN_ZSET, '-inf', '+inf', 'WITHSCORES'),
  ]);

  let cooldownCount = 0;
  let disabledCount = 0;
  for (let i = 1; i < cooldownEntries.length; i += 2) {
    if (parseInt(cooldownEntries[i], 10) === DISABLED_SCORE) {
      disabledCount++;
    } else {
      cooldownCount++;
    }
  }

  return {
    active:   activeCount,
    cooldown: cooldownCount,
    disabled: disabledCount,
    total:    activeCount + cooldownCount + disabledCount,
  };
}

/**
 * Seed the Redis key pool from the GEMINI_KEYS env var.
 * Skips keys that are already present (active or cooldown).
 */
export async function seedKeysFromEnv(keys) {
  for (const key of keys) {
    await addKey(key);
  }
}

/**
 * Load all API keys from MongoDB and rebuild the Redis key pool.
 * @param {import('ioredis').Redis} [client]
 */
export async function syncApiKeysWithDb(client) {
  const redis = client || getRedis();
  const keys = await getAllApiKeys();
  if (keys.length === 0) return false;

  const now = Date.now();

  // Clear current lists to avoid duplicates or orphans during rebuild
  await redis.del(ACTIVE_LIST, COOLDOWN_ZSET);

  for (const k of keys) {
    if (k.status === 'active') {
      await redis.rpush(ACTIVE_LIST, k.key);
    } else if (k.status === 'disabled') {
      await redis.zadd(COOLDOWN_ZSET, DISABLED_SCORE, k.key);
    } else if (k.status === 'cooldown' && k.cooldown_until) {
      const until = new Date(k.cooldown_until).getTime();
      if (until > now) {
        await redis.zadd(COOLDOWN_ZSET, until, k.key);
      } else {
        // Cooldown expired while server was offline — restore to active
        await redis.rpush(ACTIVE_LIST, k.key);
      }
    }
  }
  return true;
}

function maskKey(key) {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

/**
 * Resolve a masked key (e.g. "AIza****1234") back to the actual raw key
 * by scanning both the active list and cooldown ZSET.
 * Returns null if no match is found.
 */
async function resolveRawKey(maskedKey) {
  // If the key doesn't look masked, return as-is (it's already raw)
  if (!maskedKey.includes('****')) return maskedKey;

  const prefix = maskedKey.slice(0, 4);
  const suffix = maskedKey.slice(-4);
  const redis = getRedis();

  // Check active list
  const activeKeys = await redis.lrange(ACTIVE_LIST, 0, -1);
  for (const k of activeKeys) {
    if (k.length > 8 && k.slice(0, 4) === prefix && k.slice(-4) === suffix) {
      return k;
    }
  }

  // Check cooldown ZSET
  const cooldownKeys = await redis.zrangebyscore(COOLDOWN_ZSET, '-inf', '+inf');
  for (const k of cooldownKeys) {
    if (k.length > 8 && k.slice(0, 4) === prefix && k.slice(-4) === suffix) {
      return k;
    }
  }

  return null;
}
