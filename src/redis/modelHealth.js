import { getRedis } from './client.js';

const PREFIX = 'model_health:';
const BUCKET_MS = 900_000;  // 15-minute time buckets
const BUCKET_WINDOW = 4;    // Look back 4 buckets (1 hour) for windowed scoring
const MIN_RECENT_SAMPLES = 3; // Fall back to lifetime stats below this threshold

function hashKey(model) {
  return `${PREFIX}${model}`;
}

function currentBucketTs() {
  return Math.floor(Date.now() / BUCKET_MS);
}

function bucketKey(model, bucket) {
  return `model_health_bucket:${model}:${bucket}`;
}

/**
 * Record a successful generation.
 * Writes to both lifetime counters and the current time bucket.
 * @param {string} model
 * @param {number} latencyMs
 */
export async function recordSuccess(model, latencyMs) {
  const redis = getRedis();
  const key = hashKey(model);
  const bucket = currentBucketTs();
  const bkey = bucketKey(model, bucket);
  // Bucket expires after 2 bucket periods (30 min) so old data auto-clears
  const bucketExpireAt = Math.round(((bucket + 2) * BUCKET_MS) / 1000);

  await Promise.all([
    redis.multi()
      .hincrby(key, 'success', 1)
      .hincrby(key, 'total_latency_ms', Math.round(latencyMs))
      .hset(key, 'last_updated', Date.now())
      .exec(),
    redis.multi()
      .hincrby(bkey, 'success', 1)
      .expireat(bkey, bucketExpireAt)
      .exec(),
  ]);
}

/**
 * Record a failed generation.
 * Writes to both lifetime counters and the current time bucket.
 * @param {string} model
 * @param {'503'|'timeout'|'other'} type
 */
export async function recordFailure(model, type) {
  const redis = getRedis();
  const key = hashKey(model);
  const field = type === '503' ? 'fail_503'
    : type === 'timeout' ? 'fail_timeout'
    : 'fail_other';

  const bucket = currentBucketTs();
  const bkey = bucketKey(model, bucket);
  const bucketExpireAt = Math.round(((bucket + 2) * BUCKET_MS) / 1000);

  await Promise.all([
    redis.multi()
      .hincrby(key, field, 1)
      .hset(key, 'last_updated', Date.now())
      .exec(),
    redis.multi()
      .hincrby(bkey, field, 1)
      .expireat(bkey, bucketExpireAt)
      .exec(),
  ]);

  // Invalidate in-process best-model cache for degraded-model reasons
  if (DEGRADED_REASONS.has(String(type))) {
    invalidateBestModelCache();
  }
}

const DEGRADED_REASONS = new Set(['503', '500', '502', '504', 'timeout', 'no_keys']);

/**
 * Get computed stats for a model.
 */
export async function getModelStats(model) {
  const raw = await getRedis().hgetall(hashKey(model));
  return computeStats(model, raw);
}

/**
 * List stats for all known models.
 * Uses SCAN instead of KEYS to avoid blocking Redis on large keyspaces.
 */
export async function listAllModels() {
  const redis = getRedis();
  const keys = [];

  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');

  if (keys.length === 0) return [];

  const pipeline = redis.pipeline();
  for (const k of keys) pipeline.hgetall(k);
  const results = await pipeline.exec();

  return results.map(([, raw], i) => {
    const model = keys[i].slice(PREFIX.length);
    return computeStats(model, raw);
  });
}

/**
 * Reset all stats for a model (lifetime and buckets).
 */
export async function resetModelStats(model) {
  const redis = getRedis();
  await redis.del(hashKey(model));
  // Bucket keys auto-expire; no need to scan and delete them
}

/**
 * Pick the best model from a list of candidates based on live health scores.
 * Uses time-windowed (last 1 hour) stats when enough samples exist, falling
 * back to lifetime stats for cold/low-traffic models.
 * Cache TTL reduced to 5s (from 30s) to keep multi-instance staleness bounded.
 *
 * @param {string[]} candidates
 * @returns {Promise<string>}
 */
let _bestModelCache = { key: null, model: null, expiresAt: 0 };

export async function getBestModel(candidates) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Check cache (keyed by sorted candidate list)
  const cacheKey = candidates.join(',');
  if (_bestModelCache.key === cacheKey && Date.now() < _bestModelCache.expiresAt) {
    return _bestModelCache.model;
  }

  const redis = getRedis();
  const currentBucket = currentBucketTs();
  const pipeline = redis.pipeline();

  // For each candidate: fetch lifetime hash + BUCKET_WINDOW recent bucket hashes
  for (const model of candidates) {
    pipeline.hgetall(hashKey(model)); // offset 0: lifetime
    for (let i = 0; i < BUCKET_WINDOW; i++) {
      pipeline.hgetall(bucketKey(model, currentBucket - i)); // offsets 1..BUCKET_WINDOW
    }
  }
  const results = await pipeline.exec();

  let best = candidates[0];
  let bestScore = -Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const offset = i * (BUCKET_WINDOW + 1);
    const lifetimeRaw = results[offset][1];

    // Aggregate recent bucket data
    let rSuccess = 0, rFail503 = 0, rFailTimeout = 0, rFailOther = 0;
    for (let j = 1; j <= BUCKET_WINDOW; j++) {
      const raw = results[offset + j][1];
      if (!raw) continue;
      rSuccess += parseInt(raw.success || '0', 10);
      rFail503 += parseInt(raw.fail_503 || '0', 10);
      rFailTimeout += parseInt(raw.fail_timeout || '0', 10);
      rFailOther += parseInt(raw.fail_other || '0', 10);
    }

    const recentTotal = rSuccess + rFail503 + rFailTimeout + rFailOther;
    let score;
    if (recentTotal >= MIN_RECENT_SAMPLES) {
      // Sufficient recent data — windowed score accurately reflects current state
      score = windowedHealthScore({ success: rSuccess, fail_503: rFail503, fail_timeout: rFailTimeout, fail_other: rFailOther });
    } else {
      // Not enough recent data — fall back to lifetime Bayesian score
      score = healthScore(lifetimeRaw);
    }

    if (score > bestScore) {
      bestScore = score;
      best = candidates[i];
    }
  }

  // Cache for 5s (down from 30s) to limit cross-process staleness
  _bestModelCache = { key: cacheKey, model: best, expiresAt: Date.now() + 5_000 };
  return best;
}

/**
 * Clear the in-process best-model cache.
 * Called by recordFailure() on degraded-model events and by tests.
 */
export function invalidateBestModelCache() {
  _bestModelCache = { key: null, model: null, expiresAt: 0 };
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Lifetime Bayesian health score.
 * Smoothing with Beta(5,5) prior so cold models score ~0.5, not 1.0.
 */
function healthScore(raw) {
  if (!raw || Object.keys(raw).length === 0) return 0.5;

  const success = parseInt(raw.success || '0', 10);
  const fail503 = parseInt(raw.fail_503 || '0', 10);
  const failTimeout = parseInt(raw.fail_timeout || '0', 10);
  const failOther = parseInt(raw.fail_other || '0', 10);
  const total = success + fail503 + failTimeout + failOther;

  const successRate = (success + 5) / (total + 10);
  if (total === 0) return successRate;

  const rate503 = fail503 / total;
  const rateTimeout = failTimeout / total;

  return successRate - (rate503 * 0.3) - (rateTimeout * 0.2);
}

/**
 * Windowed health score (recent data only).
 * Uses a lighter Beta(2,2) prior since data is already time-filtered.
 */
function windowedHealthScore({ success, fail_503, fail_timeout, fail_other }) {
  const total = success + fail_503 + fail_timeout + fail_other;
  if (total === 0) return 0.5;
  const successRate = (success + 2) / (total + 4);
  const rate503 = fail_503 / total;
  const rateTimeout = fail_timeout / total;
  return successRate - (rate503 * 0.3) - (rateTimeout * 0.2);
}

function computeStats(model, raw) {
  if (!raw || Object.keys(raw).length === 0) {
    return { model, success: 0, fail_503: 0, fail_timeout: 0, fail_other: 0, success_rate: null, avg_latency_ms: null, confidence: 'low' };
  }

  const success = parseInt(raw.success || '0', 10);
  const fail503 = parseInt(raw.fail_503 || '0', 10);
  const failTimeout = parseInt(raw.fail_timeout || '0', 10);
  const failOther = parseInt(raw.fail_other || '0', 10);
  const totalLatency = parseInt(raw.total_latency_ms || '0', 10);
  const total = success + fail503 + failTimeout + failOther;

  return {
    model,
    success,
    fail_503: fail503,
    fail_timeout: failTimeout,
    fail_other: failOther,
    success_rate: total > 0 ? +(success / total).toFixed(4) : null,
    avg_latency_ms: success > 0 ? Math.round(totalLatency / success) : null,
    confidence: total < 5 ? 'low' : 'high',
    last_updated: raw.last_updated ? new Date(parseInt(raw.last_updated, 10)).toISOString() : null,
  };
}
