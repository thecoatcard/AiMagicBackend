import { getRedis } from '../redis/client.js';
import { getDb } from '../db/client.js';
import { listAllModels } from '../redis/modelHealth.js';
import { getAllKeyStats } from '../redis/keyPool.js';

const SNAPSHOT_COLLECTION = 'daily_snapshots';

/**
 * Get today's date string in IST (Asia/Kolkata), e.g. "2026-04-20"
 */
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Save today's volatile Redis data to MongoDB.
 * Called by the 11 PM IST cron job.
 */
export async function saveSnapshotToMongo() {
  const date = todayIST();
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
 * Full daily rotation: snapshot → clear.
 */
export async function runDailyRotation() {
  const snapshot = await saveSnapshotToMongo();
  const cleared = await clearVolatileRedisData();
  return { snapshot, cleared };
}

/**
 * Hydrate Redis with today's data from MongoDB.
 * Called on startup if Redis has no model health data.
 * This ensures that if the server restarts after the nightly clear,
 * users see today's accumulated data.
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

  // No model health data — try to load today's snapshot
  const date = todayIST();
  const db = await getDb();
  const snapshot = await db.collection(SNAPSHOT_COLLECTION).findOne({ _id: date });

  if (!snapshot) {
    console.info('[DailySnapshot] No snapshot found for today, starting fresh');
    return { hydrated: false, reason: 'no_snapshot' };
  }

  // Restore model health
  if (snapshot.model_health?.length > 0) {
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

  // Restore key stats
  if (snapshot.key_stats && Object.keys(snapshot.key_stats).length > 0) {
    const pipeline = redis.pipeline();
    for (const [maskedKey, stats] of Object.entries(snapshot.key_stats)) {
      pipeline.hset('gemini_key_stats', maskedKey, JSON.stringify(stats));
    }
    await pipeline.exec();
  }

  console.info(`[DailySnapshot] Hydrated Redis from ${date} snapshot (${snapshot.model_health?.length || 0} models, ${Object.keys(snapshot.key_stats || {}).length} keys)`);
  return { hydrated: true, date };
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
