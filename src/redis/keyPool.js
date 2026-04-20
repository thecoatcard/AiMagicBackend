import { getRedis } from './client.js';
import { config } from '../config.js';
import { notifyAdminKeyPoolLow } from '../services/notifications.js';
import { upsertApiKey, removeApiKey as removeKeyFromDb, getAllApiKeys } from '../db/apiKeys.js';
import { createHash } from 'crypto';

const KEY_POOL_LOW_THRESHOLD = parseInt(process.env.KEY_POOL_LOW_THRESHOLD || '5', 10);

const ACTIVE_LIST = 'gemini_keys';
const COOLDOWN_ZSET = 'gemini_keys_cooldown';
const KEY_STATS_HASH = 'gemini_key_stats'; // Hash: maskedKey -> JSON { calls, success, fail }
const KEY_REVERSE_MAP = 'gemini_key_reverse'; // Hash: maskedKey -> rawKey (O(1) reverse lookup)
// Score used to permanently disable a key (year 9999)
const DISABLED_SCORE = 253402300799000;

/**
 * Mask a key for display: first 4 + short hash + last 4.
 * Uses SHA256 to avoid collisions between keys sharing the same prefix/suffix.
 */
function maskKey(key) {
  if (!key || key.length <= 8) return '****';
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 6);
  return key.slice(0, 4) + '…' + hash + '…' + key.slice(-4);
}

/**
 * Resolve a masked key back to the actual raw key using the reverse lookup hash.
 * O(1) instead of O(N) — no scanning required.
 * Returns null if no match is found.
 */
async function resolveRawKey(maskedKey) {
  if (!maskedKey.includes('…')) return maskedKey;
  const raw = await getRedis().hget(KEY_REVERSE_MAP, maskedKey);
  return raw || null;
}

/**
 * Register a key in the reverse lookup hash (masked → raw).
 */
async function registerReverseLookup(key) {
  const masked = maskKey(key);
  await getRedis().hset(KEY_REVERSE_MAP, masked, key);
}

/**
 * Check if the key pool is exhausted (circuit breaker).
 * Returns true if no active keys AND no cooldown keys expiring within 5s.
 */
export async function isPoolExhausted() {
  const redis = getRedis();
  const [activeCount, nearExpiry] = await Promise.all([
    redis.llen(ACTIVE_LIST),
    redis.zrangebyscore(COOLDOWN_ZSET, 0, Date.now() + 5000, 'LIMIT', 0, 1),
  ]);
  return activeCount === 0 && nearExpiry.length === 0;
}

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
 * @param {string} [reason] - why the key was cooled down (e.g. '429', '503', 'admin')
 */
export async function cooldownKey(key, ttlMs, reason = 'unknown') {
  const expireAt = Date.now() + ttlMs;
  const redis = getRedis();
  await redis.lrem(ACTIVE_LIST, 0, key);
  await redis.zadd(COOLDOWN_ZSET, expireAt, key);
  
  // Sync to MongoDB with reason
  await upsertApiKey(key, { status: 'cooldown', cooldownUntil: new Date(expireAt), reason });
  
  checkPoolLow(redis).catch(() => {});
}

/**
 * Permanently disable a key (moves to cooldown with far-future score).
 * @param {string} key
 * @param {string} [reason] - why the key was disabled (e.g. 'key_invalid', 'admin')
 */
export async function disableKey(key, reason = 'unknown') {
  const redis = getRedis();
  const rawKey = await resolveRawKey(key);
  if (!rawKey) return; // Key not found in any pool
  await redis.lrem(ACTIVE_LIST, 0, rawKey);
  await redis.zadd(COOLDOWN_ZSET, DISABLED_SCORE, rawKey);
  
  // Sync to MongoDB with reason
  await upsertApiKey(rawKey, { status: 'disabled', reason });
  
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
  
  // Register reverse lookup and sync to MongoDB
  await registerReverseLookup(key);
  await upsertApiKey(key, { status: 'active' });
  
  return { added: true };
}

/**
 * Remove a key from all Redis lists, its stats, and MongoDB.
 */
export async function removeKey(key) {
  const redis = getRedis();
  const masked = maskKey(key);
  await Promise.all([
    redis.lrem(ACTIVE_LIST, 0, key),
    redis.zrem(COOLDOWN_ZSET, key),
    redis.hdel(KEY_STATS_HASH, masked),
    redis.hdel(KEY_REVERSE_MAP, masked),
    removeKeyFromDb(key),
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

  const [activeKeys, cooldownEntries, statsRaw] = await Promise.all([
    redis.lrange(ACTIVE_LIST, 0, -1),
    redis.zrangebyscore(COOLDOWN_ZSET, '-inf', '+inf', 'WITHSCORES'),
    redis.hgetall(KEY_STATS_HASH),
  ]);

  const stats = {};
  for (const [k, v] of Object.entries(statsRaw)) {
    try { stats[k] = JSON.parse(v); } catch { stats[k] = { calls: 0, success: 0, fail: 0 }; }
  }
  const defaultStats = { calls: 0, success: 0, fail: 0 };

  const active = activeKeys.map(k => {
    const masked = maskKey(k);
    return {
      key: masked,
      status: 'active',
      stats: stats[masked] ?? defaultStats,
    };
  });

  const cooldown = [];
  for (let i = 0; i < cooldownEntries.length; i += 2) {
    const k = cooldownEntries[i];
    const score = parseInt(cooldownEntries[i + 1], 10);
    const permanent = score === DISABLED_SCORE;
    const masked = maskKey(k);
    cooldown.push({
      key: masked,
      status: permanent ? 'disabled' : 'cooldown',
      cooldownRemainingMs: permanent ? null : Math.max(0, score - now),
      stats: stats[masked] ?? defaultStats,
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
 * Validates that MongoDB returned data before clearing Redis to prevent data loss.
 * @param {import('ioredis').Redis} [client]
 */
export async function syncApiKeysWithDb(client) {
  const redis = client || getRedis();
  let keys;
  try {
    keys = await getAllApiKeys();
  } catch (err) {
    console.error('[keyPool] MongoDB query failed during sync, keeping existing Redis state:', err.message);
    return false;
  }

  if (!keys || keys.length === 0) {
    // Check if Redis already has keys — if so, don't wipe them
    const existingCount = await redis.llen(ACTIVE_LIST);
    const cooldownCount = await redis.zcard(COOLDOWN_ZSET);
    if (existingCount + cooldownCount > 0) {
      console.warn('[keyPool] MongoDB returned 0 keys but Redis has', existingCount + cooldownCount, '— keeping Redis state');
      return false;
    }
    return false;
  }

  const now = Date.now();

  // Clear current lists to avoid duplicates or orphans during rebuild
  await redis.del(ACTIVE_LIST, COOLDOWN_ZSET, KEY_REVERSE_MAP);

  for (const k of keys) {
    // Register reverse lookup for every key
    await registerReverseLookup(k.key);
    
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

/**
 * Record a successful API call for a key (by masked key).
 * Uses atomic Lua script to prevent race conditions under concurrency.
 * Persists to MongoDB simultaneously so stats survive Redis restarts.
 * @param {string} maskedKey
 */
export async function recordKeySuccess(maskedKey) {
  const lua = `
    local raw = redis.call('HGET', KEYS[1], ARGV[1])
    local stats
    if raw then
      stats = cjson.decode(raw)
    else
      stats = { calls = 0, success = 0, fail = 0 }
    end
    stats.calls = stats.calls + 1
    stats.success = stats.success + 1
    redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(stats))
    return 1
  `;
  await getRedis().eval(lua, 1, KEY_STATS_HASH, maskedKey);
  // Persist to MongoDB (fire-and-forget, don't block the response)
  persistStatToMongo(maskedKey, { $inc: { 'stats.calls': 1, 'stats.success': 1 } }).catch(() => {});
}

/**
 * Record a failed API call for a key (by masked key).
 * Uses atomic Lua script to prevent race conditions under concurrency.
 * Persists to MongoDB simultaneously so stats survive Redis restarts.
 * @param {string} maskedKey
 */
export async function recordKeyFailure(maskedKey) {
  const lua = `
    local raw = redis.call('HGET', KEYS[1], ARGV[1])
    local stats
    if raw then
      stats = cjson.decode(raw)
    else
      stats = { calls = 0, success = 0, fail = 0 }
    end
    stats.calls = stats.calls + 1
    stats.fail = stats.fail + 1
    redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(stats))
    return 1
  `;
  await getRedis().eval(lua, 1, KEY_STATS_HASH, maskedKey);
  // Persist to MongoDB (fire-and-forget, don't block the response)
  persistStatToMongo(maskedKey, { $inc: { 'stats.calls': 1, 'stats.fail': 1 } }).catch(() => {});
}

/**
 * Persist a stats increment to MongoDB atomically.
 * Uses the raw key from the reverse map to find the api_keys document.
 */
async function persistStatToMongo(maskedKey, update) {
  const rawKey = await resolveRawKey(maskedKey);
  if (!rawKey) return;
  const { getDb } = await import('../db/client.js');
  const db = await getDb();
  await db.collection('api_keys').updateOne(
    { key: rawKey },
    { ...update, $set: { stats_updated_at: new Date() } },
  );
}

/**
 * Get all per-key stats.
 * @returns {Promise<Record<string, { calls: number, success: number, fail: number }>>}
 */
export async function getAllKeyStats() {
  const redis = getRedis();
  const raw = await redis.hgetall(KEY_STATS_HASH);
  const result = {};
  for (const [k, v] of Object.entries(raw)) {
    try { result[k] = JSON.parse(v); } catch { result[k] = { calls: 0, success: 0, fail: 0 }; }
  }
  return result;
}
