import { getRedis } from '../redis/client.js';
import { getUser, incrementUserUsage, decrementUserUsage } from '../db/users.js';
import { getDailyLimit } from '../config/plans.js';
import { notifyQuotaWarning } from '../services/notifications.js';
import { getDefaultPerMin, getPlanDailyLimit } from '../redis/systemConfig.js';

const LIMITS_CACHE_TTL_S  = 300; // 5-minute cache for user rate-limit data

// Lua script: atomically check limit BEFORE incrementing.
// Returns [newCount, ttl]. If limit would be exceeded, returns [-1, ttl] without incrementing.
// Re-applies EXPIRE whenever the key has no TTL (TTL == -1) — guards against
// keys that exist without a TTL (manual ops, prior crash) which would otherwise
// permanently lock out the user.
const RATE_LIMIT_LUA = `
  local key = KEYS[1]
  local limit = tonumber(ARGV[1])
  local ttl_s = tonumber(ARGV[2])
  local incr = tonumber(ARGV[3])
  local current = tonumber(redis.call('GET', key) or '0')
  if current + incr > limit then
    local t = redis.call('TTL', key)
    return {-1, t > 0 and t or ttl_s}
  end
  local newVal = redis.call('INCRBY', key, incr)
  local t = redis.call('TTL', key)
  if t < 0 then
    redis.call('EXPIRE', key, ttl_s)
    t = ttl_s
  end
  return {newVal, t}
`;

/**
 * Fastify preHandler — enforces per-user rate limits (requests/min + requests/day).
 * Admins and owners bypass rate limiting entirely.
 * Per-minute limit: from user.limits.max_requests_per_min (default 60).
 * Per-day limit:    from user.limits.max_requests_per_day (custom override)
 *                   OR getDailyLimit(user.plan) from plans config.
 */
export async function checkUserRateLimit(request, reply) {
  const { email, role } = request.user;
  if (role === 'admin' || role === 'owner') {
    incrementUserUsage(email); // admins are not rate-limited but their calls are still counted
    return;
  }

  const redis = getRedis();
  const cached = await getCachedRateLimitData(email, redis) ?? await loadAndCache(email, redis);

  const maxPerMin = cached.max_requests_per_min ?? cached.default_per_min ?? 60;
  const maxPerDay = cached.max_requests_per_day ?? cached.plan_daily_limit ?? getDailyLimit(cached.plan ?? 'free');

  const minKey = `rate:${email}:min`;
  const dayKey = `rate:${email}:day`;

  // Atomic check-then-increment for per-minute limit
  const [minCount, minTtl] = await redis.eval(RATE_LIMIT_LUA, 1, minKey, maxPerMin, 60, 1);

  if (minCount === -1) {
    reply.status(429).send({
      error:            `Rate limit exceeded: max ${maxPerMin} requests per minute`,
      code:             'RATE_LIMIT_EXCEEDED',
      reset_in_seconds: minTtl,
    });
    return;
  }

  // Atomic check-then-increment for daily limit
  const [dayCount, dayTtl] = await redis.eval(RATE_LIMIT_LUA, 1, dayKey, maxPerDay, 86400, 1);

  if (dayCount === -1) {
    // Don't re-fire the quota notification — the 80%-tier warning already
    // fired on the request that crossed the threshold. Blocked requests
    // just return 429.
    reply.status(429).send({
      error:            `Daily quota exceeded: max ${maxPerDay} requests per day (${cached.plan ?? 'free'} plan)`,
      code:             'DAILY_LIMIT_EXCEEDED',
      limit:            maxPerDay,
      reset_in_seconds: dayTtl,
    });
    return;
  }

  // Fire 80% quota warning (non-blocking; notifyQuotaWarning self-throttles)
  notifyQuotaWarning(email, { used: dayCount, limit: maxPerDay, resetInSeconds: dayTtl });

  incrementUserUsage(email);
}

/**
 * Fastify preHandler — same as checkUserRateLimit but counts each prompt
 * in the batch individually (INCRBY n instead of INCR 1).
 */
export async function checkBatchRateLimit(request, reply) {
  const { email, role } = request.user;
  const count = request.body?.prompts?.length ?? 1;

  if (role === 'admin' || role === 'owner') {
    incrementUserUsage(email, count); // count each prompt in the batch
    return;
  }
  const redis = getRedis();
  const cached = await getCachedRateLimitData(email, redis) ?? await loadAndCache(email, redis);

  const maxPerMin = cached.max_requests_per_min ?? cached.default_per_min ?? 60;
  const maxPerDay = cached.max_requests_per_day ?? cached.plan_daily_limit ?? getDailyLimit(cached.plan ?? 'free');

  const minKey = `rate:${email}:min`;
  const dayKey = `rate:${email}:day`;

  // Atomic check-then-increment for per-minute limit
  const [minCount, minTtl] = await redis.eval(RATE_LIMIT_LUA, 1, minKey, maxPerMin, 60, count);

  if (minCount === -1) {
    reply.status(429).send({
      error:            `Rate limit exceeded: max ${maxPerMin} requests per minute`,
      code:             'RATE_LIMIT_EXCEEDED',
      reset_in_seconds: minTtl,
    });
    return;
  }

  // Atomic check-then-increment for daily limit
  const [dayCount, dayTtl] = await redis.eval(RATE_LIMIT_LUA, 1, dayKey, maxPerDay, 86400, count);

  if (dayCount === -1) {
    // Don't re-fire the quota notification — the 80%-tier warning already
    // fired on the request that crossed the threshold.
    reply.status(429).send({
      error:            `Daily quota exceeded: max ${maxPerDay} requests per day (${cached.plan ?? 'free'} plan)`,
      code:             'DAILY_LIMIT_EXCEEDED',
      limit:            maxPerDay,
      reset_in_seconds: dayTtl,
    });
    return;
  }

  notifyQuotaWarning(email, { used: dayCount, limit: maxPerDay, resetInSeconds: dayTtl });

  incrementUserUsage(email, count);
}

/**
 * Returns the current daily usage count for a user from Redis.
 * Used by the /v1/quota endpoint.
 */
export async function getDailyUsage(email) {
  const redis = getRedis();
  const [count, ttl] = await Promise.all([
    redis.get(`rate:${email}:day`),
    redis.ttl(`rate:${email}:day`),
  ]);
  return {
    used:        Number(count ?? 0),
    reset_in_seconds: ttl > 0 ? ttl : 86400,
  };
}

/**
 * Call this whenever admin updates a user's limits or plan to bust the
 * cache so the new limits take effect immediately.
 */
export async function invalidateUserLimitsCache(email) {
  await getRedis().del(`user_limits_cache:${email}`);
}

// Lua: atomically DECRBY both per-min and per-day counters, flooring at 0.
// Used to credit back quota when a batch job terminally fails — otherwise the
// user is charged for upstream failures with no compensation.
const CREDIT_BACK_LUA = `
  local function dec(key, n)
    local v = redis.call('DECRBY', key, n)
    if v < 0 then redis.call('SET', key, 0) end
  end
  dec(KEYS[1], tonumber(ARGV[1]))
  dec(KEYS[2], tonumber(ARGV[1]))
  return 1
`;

/**
 * Credit back `count` units of quota to a user (per-min AND per-day counters).
 * Floors at 0 to avoid negative counters. Also decrements MongoDB usage count.
 */
export async function refundQuota(email, count = 1) {
  if (!email || !Number.isFinite(count) || count <= 0) return;
  
  // Refund MongoDB (total count)
  decrementUserUsage(email, count);

  // Refund Redis (rate limits)
  try {
    const minKey = `rate:${email}:min`;
    const dayKey = `rate:${email}:day`;
    await getRedis().eval(CREDIT_BACK_LUA, 2, minKey, dayKey, count);
  } catch {
    // Non-critical — Redis outage shouldn't break worker failure handling
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function getCachedRateLimitData(email, redis) {
  const raw = await redis.get(`user_limits_cache:${email}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function loadAndCache(email, redis) {
  const user = await getUser(email);
  const plan = user?.plan ?? 'free';
  // Fetch both global defaults from Redis so they're baked into the per-user cache.
  // This means changes to global settings take effect within the 5-minute cache window,
  // and bustAllUserCaches() makes them instant.
  const [defaultPerMin, planDailyLimit] = await Promise.all([
    getDefaultPerMin(),
    getPlanDailyLimit(plan),
  ]);
  const data = {
    max_requests_per_min: user?.limits?.max_requests_per_min ?? null,
    max_requests_per_day: user?.limits?.max_requests_per_day ?? null, // null = use plan default
    plan,
    default_per_min:   defaultPerMin,
    plan_daily_limit:  planDailyLimit,
  };
  redis.set(`user_limits_cache:${email}`, JSON.stringify(data), 'EX', LIMITS_CACHE_TTL_S)
    .catch(() => {});
  return data;
}
