import { getRedis } from './client.js';

const PREFIX = 'model_health:';

function hashKey(model) {
  return `${PREFIX}${model}`;
}

/**
 * Record a successful generation.
 * @param {string} model
 * @param {number} latencyMs
 */
export async function recordSuccess(model, latencyMs) {
  const redis = getRedis();
  const key = hashKey(model);
  await redis.pipeline()
    .hincrby(key, 'success', 1)
    .hincrby(key, 'total_latency_ms', Math.round(latencyMs))
    .hset(key, 'last_updated', Date.now())
    .exec();
}

/**
 * Record a failed generation.
 * @param {string} model
 * @param {'503'|'timeout'|'other'} type
 */
export async function recordFailure(model, type) {
  const redis = getRedis();
  const key = hashKey(model);
  const field = type === '503' ? 'fail_503'
    : type === 'timeout' ? 'fail_timeout'
    : 'fail_other';
  await redis.pipeline()
    .hincrby(key, field, 1)
    .hset(key, 'last_updated', Date.now())
    .exec();
}

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
 * Reset all stats for a model.
 */
export async function resetModelStats(model) {
  await getRedis().del(hashKey(model));
}

/**
 * Pick the best model from a list of candidates based on live health scores.
 * Falls back to the first candidate if no health data exists yet.
 * Caches result for 30s to avoid recalculating on every request.
 *
 * Score = success_rate - (fail_503_rate * 0.3) - (fail_timeout_rate * 0.2)
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
  const pipeline = redis.pipeline();
  for (const model of candidates) pipeline.hgetall(hashKey(model));
  const results = await pipeline.exec();

  let best = candidates[0];
  let bestScore = -Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const raw = results[i][1];
    const score = healthScore(raw);
    if (score > bestScore) {
      bestScore = score;
      best = candidates[i];
    }
  }

  // Cache for 30 seconds
  _bestModelCache = { key: cacheKey, model: best, expiresAt: Date.now() + 30_000 };

  return best;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function healthScore(raw) {
  if (!raw || Object.keys(raw).length === 0) return 1; // no data → assume healthy

  const success = parseInt(raw.success || '0', 10);
  const fail503 = parseInt(raw.fail_503 || '0', 10);
  const failTimeout = parseInt(raw.fail_timeout || '0', 10);
  const failOther = parseInt(raw.fail_other || '0', 10);
  const total = success + fail503 + failTimeout + failOther;

  if (total === 0) return 1;

  const successRate = success / total;
  const rate503 = fail503 / total;
  const rateTimeout = failTimeout / total;

  return successRate - (rate503 * 0.3) - (rateTimeout * 0.2);
}

function computeStats(model, raw) {
  if (!raw || Object.keys(raw).length === 0) {
    return { model, success: 0, fail_503: 0, fail_timeout: 0, fail_other: 0, success_rate: null, avg_latency_ms: null };
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
    last_updated: raw.last_updated ? new Date(parseInt(raw.last_updated, 10)).toISOString() : null,
  };
}
