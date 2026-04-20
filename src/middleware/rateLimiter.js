import { getRedis } from '../redis/client.js';
import { getUser, incrementUserUsage } from '../db/users.js';
import { getDailyLimit } from '../config/plans.js';
import { notifyQuotaWarning } from '../services/notifications.js';
import { getDefaultPerMin, getPlanDailyLimit } from '../redis/systemConfig.js';

const LIMITS_CACHE_TTL_S  = 300; // 5-minute cache for user rate-limit data

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

  // Check per-minute limit first to avoid inflating daily counter on rejected requests
  const minCount = await redis.incr(minKey);
  if (minCount === 1) await redis.expire(minKey, 60);

  if (minCount > maxPerMin) {
    const ttl = await redis.ttl(minKey);
    reply.status(429).send({
      error:            `Rate limit exceeded: max ${maxPerMin} requests per minute`,
      code:             'RATE_LIMIT_EXCEEDED',
      reset_in_seconds: ttl,
    });
    return;
  }

  // Per-minute OK — now increment and check daily counter
  const dayCount = await redis.incr(dayKey);
  if (dayCount === 1) await redis.expire(dayKey, 86400);

  if (dayCount > maxPerDay) {
    const ttl = await redis.ttl(dayKey);
    // Fire quota-exhausted warning (100%) — throttled inside notifyQuotaWarning
    notifyQuotaWarning(email, { used: dayCount, limit: maxPerDay, resetInSeconds: ttl });
    reply.status(429).send({
      error:            `Daily quota exceeded: max ${maxPerDay} requests per day (${cached.plan ?? 'free'} plan)`,
      code:             'DAILY_LIMIT_EXCEEDED',
      limit:            maxPerDay,
      reset_in_seconds: ttl,
    });
    return;
  }

  // Fire 80% quota warning (non-blocking; notifyQuotaWarning self-throttles)
  const ttlDay = await redis.ttl(dayKey);
  notifyQuotaWarning(email, { used: dayCount, limit: maxPerDay, resetInSeconds: ttlDay });

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

  // Check per-minute limit first to avoid inflating daily counter on rejected requests
  const minCount = await redis.incrby(minKey, count);
  if (minCount === count) await redis.expire(minKey, 60);

  if (minCount > maxPerMin) {
    const ttl = await redis.ttl(minKey);
    reply.status(429).send({
      error:            `Rate limit exceeded: max ${maxPerMin} requests per minute`,
      code:             'RATE_LIMIT_EXCEEDED',
      reset_in_seconds: ttl,
    });
    return;
  }

  // Per-minute OK — now increment and check daily counter
  const dayCount = await redis.incrby(dayKey, count);
  if (dayCount === count) await redis.expire(dayKey, 86400);

  if (dayCount > maxPerDay) {
    const ttl = await redis.ttl(dayKey);
    notifyQuotaWarning(email, { used: dayCount, limit: maxPerDay, resetInSeconds: ttl });
    reply.status(429).send({
      error:            `Daily quota exceeded: max ${maxPerDay} requests per day (${cached.plan ?? 'free'} plan)`,
      code:             'DAILY_LIMIT_EXCEEDED',
      limit:            maxPerDay,
      reset_in_seconds: ttl,
    });
    return;
  }

  const ttlDay = await redis.ttl(dayKey);
  notifyQuotaWarning(email, { used: dayCount, limit: maxPerDay, resetInSeconds: ttlDay });

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
