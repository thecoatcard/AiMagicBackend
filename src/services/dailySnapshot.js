import { getRedis } from '../redis/client.js';
import { getDb } from '../db/client.js';
import { listAllModels } from '../redis/modelHealth.js';
import { getAllKeyStats } from '../redis/keyPool.js';

const SNAPSHOT_COLLECTION = 'daily_snapshots';

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
 * Save yesterday's volatile Redis data to MongoDB, then clear it.
 * Called at 12:00 AM IST — snapshots the previous day's data and resets Redis.
 * Stats are also persisted in real-time to MongoDB (api_keys collection),
 * so this snapshot is for historical aggregation / dashboards.
 */
export async function saveSnapshotToMongo() {
  const date = yesterdayIST();
  const db = await getDb();

  // 1. Snapshot model health stats
  const modelHealth = await listAllModels();

  // 2. Snapshot per-key stats
  const keyStats = await getAllKeyStats();

  // 3. Snapshot rate limit counters (scan for rate:*:day keys)
  const redis = getRedis();
  const rateLimits = {};
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'rate:*:day', 'COUNT', 200);
    cursor = nextCursor;
    if (keys.length > 0) {
      const pipeline = redis.pipeline();
      for (const k of keys) pipeline.get(k);
      const results = await pipeline.exec();
      keys.forEach((k, i) => {
        // k = "rate:user@example.com:day"
        const email = k.slice(5, -4); // strip "rate:" and ":day"
        const count = parseInt(results[i][1] || '0', 10);
        if (count > 0) rateLimits[email] = count;
      });
    }
  } while (cursor !== '0');

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
 */
export async function clearVolatileRedisData() {
  const redis = getRedis();
  const patterns = [
    'model_health:*',
    'rate:*',
    'user_limits_cache:*',
    'alert:*',
    'failure_rate:*',
  ];

  let totalDeleted = 0;

  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
        totalDeleted += keys.length;
      }
    } while (cursor !== '0');
  }

  // Delete single keys
  await redis.del('gemini_key_stats');
  totalDeleted++;

  console.info(`[DailySnapshot] Cleared ${totalDeleted} volatile Redis keys`);
  return { deleted: totalDeleted };
}

/**
 * Full daily rotation at 12 AM IST: snapshot yesterday's data → clear Redis counters.
 */
export async function runDailyRotation() {
  const snapshot = await saveSnapshotToMongo();
  const cleared = await clearVolatileRedisData();
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

  // Check if Redis already has model health data
  let cursor = '0';
  const [, existingKeys] = await redis.scan(cursor, 'MATCH', 'model_health:*', 'COUNT', 10);
  if (existingKeys.length > 0) {
    console.info('[DailySnapshot] Redis already has model health data, skipping hydration');
    return { hydrated: false };
  }

  const db = await getDb();

  // Restore key stats from api_keys collection (real-time persisted)
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
  }

  // Try to load model health from the most recent snapshot
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
  }

  console.info(`[DailySnapshot] Hydrated Redis (${apiKeys.length} key stats, ${snapshot?.model_health?.length || 0} models)`);
  return { hydrated: true, keyStats: apiKeys.length, models: snapshot?.model_health?.length || 0 };
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
