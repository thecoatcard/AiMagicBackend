import os from 'os';
import { getRedis } from '../redis/client.js';
import { getDb } from '../db/client.js';
import { listAllModels } from '../redis/modelHealth.js';
import { getAllKeyStats } from '../redis/keyPool.js';

const SNAPSHOT_COLLECTION = 'daily_snapshots';

// Stable per-process identifier for the leader lock (FIX-3)
const INSTANCE_ID = `${os.hostname()}:${process.pid}`;

/**
 * Get yesterday's date string in IST (Asia/Kolkata), e.g. "2026-04-19"
 */
function yesterdayIST() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Get today's date string in IST (Asia/Kolkata), e.g. "2026-04-20"
 */
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Calendar-day boundaries for "yesterday" in IST, returned as UTC Date objects.
 * Used to scope daily-summary aggregations to a true 24h IST window
 * (avoids the rolling-window double-counting bug — FIX-3).
 */
export function getYesterdayBoundsIST() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const yIst = new Date(nowIst);
  yIst.setUTCDate(yIst.getUTCDate() - 1);
  yIst.setUTCHours(0, 0, 0, 0);
  const startUtc = new Date(yIst.getTime() - IST_OFFSET_MS);
  const endUtc = new Date(startUtc.getTime() + 86400 * 1000);
  return { startUtc, endUtc };
}

/**
 * Atomically rotate `rate:*:day` keys into a frozen snapshot namespace
 * `rate:<id>:day:rotating:<dateStamp>` so that in-flight requests writing to
 * `rate:<id>:day` create brand-new keys (tomorrow's counters) while the
 * snapshot reads from the rotated set. Returns the list of renamed keys.
 *
 * RENAME / RENAMENX on a single key are atomic in Redis. We use RENAMENX
 * defensively to avoid clobbering any leftover rotated key from a failed
 * previous run (those are cleaned up at the start of runDailyRotation).
 */
async function rotateRateKeys(dateStamp) {
  const redis = getRedis();
  const renamed = [];
  let cursor = '0';
  do {
    let res;
    try {
      res = await redis.scan(cursor, 'MATCH', 'rate:*:day', 'COUNT', 200);
    } catch (err) {
      console.warn('[DailySnapshot] rotateRateKeys SCAN failed', err?.message);
      break;
    }
    const [nextCursor, keys] = res;
    cursor = nextCursor;
    for (const k of keys) {
      // Skip any already-rotated keys we accidentally matched
      if (k.includes(':rotating:')) continue;
      const target = `${k}:rotating:${dateStamp}`;
      try {
        if (typeof redis.renamenx === 'function') {
          await redis.renamenx(k, target);
        } else {
          await redis.rename(k, target);
        }
        renamed.push(target);
      } catch (err) {
        // Source missing (already moved) or target collision — non-fatal
        console.warn(`[DailySnapshot] rename failed for ${k} -> ${target}: ${err?.message}`);
      }
    }
  } while (cursor !== '0');
  return renamed;
}

/**
 * Remove leftover `rate:*:day:rotating:*` keys from a previously failed
 * rotation so they don't accumulate indefinitely.
 */
async function cleanupStaleRotatedKeys() {
  const redis = getRedis();
  let cursor = '0';
  let deleted = 0;
  do {
    let res;
    try {
      res = await redis.scan(cursor, 'MATCH', 'rate:*:day:rotating:*', 'COUNT', 200);
    } catch (err) {
      console.warn('[DailySnapshot] cleanupStaleRotatedKeys SCAN failed', err?.message);
      break;
    }
    const [nextCursor, keys] = res;
    cursor = nextCursor;
    if (keys.length > 0) {
      try {
        await redis.unlink(...keys);
        deleted += keys.length;
      } catch (err) {
        console.warn('[DailySnapshot] cleanupStaleRotatedKeys UNLINK failed', err?.message);
      }
    }
  } while (cursor !== '0');
  if (deleted > 0) {
    console.info(`[DailySnapshot] Removed ${deleted} stale rotated rate keys from previous run`);
  }
  return deleted;
}

/**
 * Save yesterday's volatile Redis data to MongoDB, then clear it.
 * Called at 12:00 AM IST — snapshots the previous day's data and resets Redis.
 * Stats are also persisted in real-time to MongoDB (api_keys collection),
 * so this snapshot is for historical aggregation / dashboards.
 *
 * @param {string[]} [renamedKeys] Optional list of rotated rate keys
 *   (from rotateRateKeys) to read from. When omitted, falls back to
 *   scanning the live `rate:*:day` namespace (legacy behavior).
 */
export async function saveSnapshotToMongo(renamedKeys) {
  const date = yesterdayIST();
  const db = await getDb();

  // 1. Snapshot model health stats
  const modelHealth = await listAllModels();

  // 2. Snapshot per-key stats
  const keyStats = await getAllKeyStats();

  // 3. Snapshot rate limit counters
  const redis = getRedis();
  const rateLimits = {};

  // Helper: extract email/identifier from a rate key. Handles both
  // live keys (`rate:<id>:day`) and rotated keys (`rate:<id>:day:rotating:<date>`).
  const extractId = (k) => {
    const rotIdx = k.indexOf(':day:rotating:');
    const end = rotIdx === -1 ? k.length - 4 /* strip ":day" */ : rotIdx;
    return k.slice(5, end); // strip leading "rate:"
  };

  const readKeys = async (keys) => {
    if (!keys.length) return;
    const pipeline = redis.pipeline();
    for (const k of keys) pipeline.get(k);
    const results = await pipeline.exec();
    keys.forEach((k, i) => {
      const id = extractId(k);
      const count = parseInt(results[i][1] || '0', 10);
      if (count > 0) rateLimits[id] = count;
    });
  };

  if (Array.isArray(renamedKeys)) {
    // Read directly from the frozen rotated namespace (FIX-1, no race)
    await readKeys(renamedKeys);
  } else {
    // Legacy path: scan live namespace
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'rate:*:day', 'COUNT', 200);
      cursor = nextCursor;
      await readKeys(keys);
    } while (cursor !== '0');
  }

  // 4. Upsert snapshot document (idempotent — safe to run multiple times)
  await db.collection(SNAPSHOT_COLLECTION).updateOne(
    { _id: date },
    {
      $set: {
        date,
        model_health: modelHealth,
        key_stats: keyStats,
        daily_usage: rateLimits,
        snapshot_at: new Date(),
      },
    },
    { upsert: true },
  );

  console.info(`[DailySnapshot] Saved snapshot for ${date}`);
  return { date, models: modelHealth.length, keys: Object.keys(keyStats).length, users: Object.keys(rateLimits).length };
}

/**
 * Clear volatile Redis data, preserving:
 *  - API keys: gemini_keys, gemini_keys_cooldown
 *  - Config: system:config, model:config
 *  - Sessions: sessions:v2:*
 *
 * Clears:
 *  - model_health:* (model health counters)
 *  - gemini_key_stats (per-key call stats)
 *  - rate:*:min, rate:*:day (rate limit counters)
 *  - user_limits_cache:* (cached user limits)
 *  - alert:* (alert throttles)
 *  - failure_rate:* (failure rate buckets)
 *
 * @param {string[]} [renamedRateKeys] When provided (post-rotation), the
 *   rate-key cleanup unlinks ONLY these frozen keys instead of scanning
 *   `rate:*` — which would also delete tomorrow's freshly-created counters.
 *   Other patterns (model_health, alert, etc.) are not racing sources of
 *   truth, so they keep the SCAN+UNLINK behavior.
 */
export async function clearVolatileRedisData(renamedRateKeys) {
  const redis = getRedis();
  const useRotated = Array.isArray(renamedRateKeys);
  const patterns = useRotated
    ? ['model_health:*', 'user_limits_cache:*', 'alert:*', 'failure_rate:*']
    : ['model_health:*', 'rate:*', 'user_limits_cache:*', 'alert:*', 'failure_rate:*'];

  let totalDeleted = 0;

  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.unlink(...keys);
        totalDeleted += keys.length;
      }
    } while (cursor !== '0');
  }

  // Unlink the frozen rotated rate keys (FIX-1) — chunked to avoid huge args
  if (useRotated && renamedRateKeys.length > 0) {
    for (let i = 0; i < renamedRateKeys.length; i += 200) {
      const chunk = renamedRateKeys.slice(i, i + 200);
      try {
        await redis.unlink(...chunk);
        totalDeleted += chunk.length;
      } catch (err) {
        console.warn('[DailySnapshot] unlink rotated rate keys failed', err?.message);
      }
    }
  }

  // Delete single keys
  await redis.unlink('gemini_key_stats');
  totalDeleted++;

  console.info(`[DailySnapshot] Cleared ${totalDeleted} volatile Redis keys`);
  return { deleted: totalDeleted };
}

/**
 * Full daily rotation at 12 AM IST:
 *   1. Acquire single-leader Redis lock (FIX-3) — skip if another instance holds it.
 *   2. Sweep any leftover rotated keys from a failed prior run.
 *   3. Atomically rename live `rate:*:day` keys into a frozen snapshot namespace.
 *   4. Snapshot the frozen rate keys + model health + key stats to Mongo.
 *   5. Clear remaining volatile Redis data (and the frozen rotated keys).
 */
export async function runDailyRotation() {
  const redis = getRedis();
  const dateStamp = yesterdayIST();
  const lockKey = `daily_rotation_lock:${dateStamp}`;

  // Leader lock — auto-released after 1h TTL (FIX-3)
  let acquired = true;
  try {
    const result = await redis.set(lockKey, INSTANCE_ID, 'EX', 3600, 'NX');
    acquired = result === 'OK';
  } catch (err) {
    // If SET NX fails, fall through and proceed (single-instance fallback).
    console.warn('[DailySnapshot] leader lock SET NX failed, proceeding anyway', err?.message);
  }
  if (!acquired) {
    console.info(`[DailySnapshot] Another instance is rotating ${dateStamp}, skipping`);
    return { skipped: true, reason: 'leader_lock_held' };
  }

  // Clear any rotated keys left behind by a previous failed rotation
  await cleanupStaleRotatedKeys();

  // Atomically freeze today's live counters into the rotated namespace
  const renamedKeys = await rotateRateKeys(dateStamp);

  const snapshot = await saveSnapshotToMongo(renamedKeys);
  const cleared = await clearVolatileRedisData(renamedKeys);
  return { snapshot, cleared };
}

/**
 * Hydrate Redis with today's data from MongoDB.
 * Called on startup if Redis has no model health data.
 * Loads key stats from the api_keys collection (real-time persisted),
 * and model health from the last snapshot if available.
 */
export async function hydrateFromMongoIfNeeded() {
  const redis = getRedis();

  // Independent emptiness checks (FIX-2): model_health and gemini_key_stats
  // hydrate independently. A populated model_health no longer skips key-stats.
  let modelHealthEmpty = true;
  try {
    const [, existingKeys] = await redis.scan('0', 'MATCH', 'model_health:*', 'COUNT', 10);
    modelHealthEmpty = existingKeys.length === 0;
  } catch (err) {
    console.warn('[DailySnapshot] hydrate: model_health scan failed', err?.message);
  }

  let keyStatsEmpty = true;
  try {
    if (typeof redis.hlen === 'function') {
      const len = await redis.hlen('gemini_key_stats');
      keyStatsEmpty = !len || len === 0;
    } else {
      const exists = await redis.exists?.('gemini_key_stats');
      keyStatsEmpty = !exists;
    }
  } catch (err) {
    console.warn('[DailySnapshot] hydrate: gemini_key_stats check failed', err?.message);
  }

  if (!modelHealthEmpty && !keyStatsEmpty) {
    console.info('[DailySnapshot] Redis already populated, skipping hydration');
    return { hydrated: false };
  }

  const db = await getDb();
  let restoredKeyStats = 0;
  let restoredModels = 0;

  // Hydrate gemini_key_stats from api_keys collection (real-time persisted)
  if (keyStatsEmpty) {
    try {
      const apiKeys = await db.collection('api_keys').find(
        { 'stats.calls': { $gt: 0 } },
        { projection: { key: 1, stats: 1 } },
      ).toArray();

      if (apiKeys.length > 0) {
        const { createHash } = await import('crypto');
        const pipeline = redis.pipeline();
        for (const doc of apiKeys) {
          if (doc.stats && doc.key) {
            const hash = createHash('sha256').update(doc.key).digest('hex').slice(0, 6);
            const masked = doc.key.slice(0, 4) + '…' + hash + '…' + doc.key.slice(-4);
            pipeline.hset('gemini_key_stats', masked, JSON.stringify(doc.stats));
          }
        }
        await pipeline.exec();
        restoredKeyStats = apiKeys.length;
      }
    } catch (err) {
      console.warn('[DailySnapshot] hydrate: gemini_key_stats restore failed', err?.message);
    }
  }

  // Hydrate model_health from the most recent snapshot
  if (modelHealthEmpty) {
    try {
      const date = todayIST();
      const snapshot = await db.collection(SNAPSHOT_COLLECTION).findOne({ _id: date })
        || await db.collection(SNAPSHOT_COLLECTION).findOne({}, { sort: { _id: -1 } });

      if (snapshot?.model_health?.length > 0) {
        const pipeline = redis.pipeline();
        for (const m of snapshot.model_health) {
          const key = `model_health:${m.model}`;
          pipeline.hset(key,
            'success', String(m.success || 0),
            'fail_503', String(m.fail_503 || 0),
            'fail_timeout', String(m.fail_timeout || 0),
            'fail_other', String(m.fail_other || 0),
            'total_latency_ms', String(m.total_latency_ms || 0),
            'last_updated', String(Date.now()),
          );
        }
        await pipeline.exec();
        restoredModels = snapshot.model_health.length;
      }
    } catch (err) {
      console.warn('[DailySnapshot] hydrate: model_health restore failed', err?.message);
    }
  }

  console.info(`[DailySnapshot] Hydrated Redis (${restoredKeyStats} key stats, ${restoredModels} models)`);
  return { hydrated: true, keyStats: restoredKeyStats, models: restoredModels };
}

/**
 * Get snapshot for a specific date.
 */
export async function getSnapshot(date) {
  const db = await getDb();
  return db.collection(SNAPSHOT_COLLECTION).findOne({ _id: date });
}

/**
 * List recent snapshots.
 */
export async function listSnapshots(limit = 30) {
  const db = await getDb();
  return db.collection(SNAPSHOT_COLLECTION)
    .find({}, { projection: { model_health: 0, key_stats: 0, daily_usage: 0 } })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();
}
