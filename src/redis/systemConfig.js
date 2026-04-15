/**
 * Redis-backed live system configuration.
 * Stored in a single hash: system:config
 * Allows admin to change runtime behaviour without restarting the server.
 */

import { getRedis } from './client.js';
import { PLANS } from '../config/plans.js';

const CONFIG_KEY = 'system:config';

// Default values — used when a key has not been set in Redis yet.
const DEFAULTS = {
  maintenance_mode:        '0',
  generation_enabled:      '1',
  registration_enabled:    '1',
  default_per_min:         '60',
  alert_failure_threshold: '10',
  alert_queue_threshold:   '100',
  alert_pool_low_threshold:'5',
  gen_temperature:         '',   // empty = use model default
  gen_max_tokens:          '',   // empty = use model default
  payment_upi_1:           '',
  payment_upi_2:           '',
  payment_qr_path:         '',
  payment_qr_file_id:      '',
  // Email Notification Toggles (1=enabled, 0=disabled)
  email_security_enabled:  '1',
  email_status_enabled:    '1',
  email_tickets_enabled:   '1',
  email_quota_enabled:     '1',
  email_admin_alerts_enabled: '1',
};

/**
 * Get a single system config value from Redis.
 * Returns the DEFAULTS fallback if the key has never been set.
 */
export async function getSystemConfig(key) {
  const value = await getRedis().hget(CONFIG_KEY, key);
  return value ?? DEFAULTS[key] ?? null;
}

/**
 * Get all system config values, merging stored values over defaults.
 */
export async function getAllSystemConfig() {
  const stored = (await getRedis().hgetall(CONFIG_KEY)) ?? {};
  return { ...DEFAULTS, ...stored };
}

/**
 * Set one or more system config values (all values stored as strings).
 * @param {Record<string, string>} updates
 */
export async function setSystemConfig(updates) {
  const flat = [];
  for (const [k, v] of Object.entries(updates)) {
    flat.push(k, String(v));
  }
  if (flat.length > 0) {
    await getRedis().hset(CONFIG_KEY, ...flat);
  }
}

/** Is the system currently in maintenance mode? */
export async function isMaintenanceMode() {
  return (await getSystemConfig('maintenance_mode')) === '1';
}

/** Is content generation currently enabled? */
export async function isGenerationEnabled() {
  return (await getSystemConfig('generation_enabled')) === '1';
}

/** Is user registration (OTP request) currently enabled? */
export async function isRegistrationEnabled() {
  return (await getSystemConfig('registration_enabled')) === '1';
}

/**
 * Get the global default per-minute rate limit.
 * Falls back to 60 if unset or unparseable.
 */
export async function getDefaultPerMin() {
  const val = await getSystemConfig('default_per_min');
  return parseInt(val, 10) || 60;
}

/**
 * Get the daily request limit for a plan.
 * Checks Redis for an admin override; falls back to plans.js constant.
 * @param {string} plan
 */
export async function getPlanDailyLimit(plan) {
  const key = `plan_limit_${plan}`;
  const val = await getSystemConfig(key);
  // Non-empty and not the default means admin has set a custom value
  if (val !== null && val !== '' && !(key in DEFAULTS)) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed)) return parsed;
  }
  // Also check if it was explicitly stored (even if it matches DEFAULTS)
  const stored = await getRedis().hget(CONFIG_KEY, key);
  if (stored !== null) {
    const parsed = parseInt(stored, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return PLANS[plan]?.daily_requests ?? PLANS.free.daily_requests;
}

/**
 * Seed plan limits to Redis from plans.js on startup.
 * Only sets keys that are not already stored (preserves admin overrides).
 */
export async function seedPlanLimitsToRedis() {
  const redis = getRedis();
  for (const [planName, planDef] of Object.entries(PLANS)) {
    const key = `plan_limit_${planName}`;
    const existing = await redis.hget(CONFIG_KEY, key);
    if (!existing) {
      await redis.hset(CONFIG_KEY, key, String(planDef.daily_requests));
    }
  }
}

/**
 * Record a failure tick for failure-rate tracking.
 * Uses per-minute buckets keyed by ISO timestamp (minute precision).
 * Buckets expire after 1 hour automatically.
 */
export async function recordFailureRateTick() {
  const redis = getRedis();
  const bucket = `failure_rate:${new Date().toISOString().slice(0, 16)}`; // e.g. failure_rate:2026-04-15T09:23
  await redis.incr(bucket);
  await redis.expire(bucket, 3600);
}

/**
 * Get the total failure count across the last N minutes.
 * @param {number} windowMinutes
 */
export async function getFailureRateCount(windowMinutes = 5) {
  const redis = getRedis();
  const now = new Date();
  const buckets = [];
  for (let i = 0; i < windowMinutes; i++) {
    const t = new Date(now - i * 60_000);
    buckets.push(`failure_rate:${t.toISOString().slice(0, 16)}`);
  }
  if (buckets.length === 0) return 0;
  const counts = await redis.mget(...buckets);
  return counts.reduce((sum, c) => sum + (parseInt(c, 10) || 0), 0);
}

/**
 * Bust all per-user limits caches.
 * Call after changing plan limits or default_per_min so changes take effect within seconds.
 * @returns {number} number of keys deleted
 */
export async function bustAllUserCaches() {
  const redis = getRedis();
  const stream = redis.scanStream({ match: 'user_limits_cache:*', count: 100 });
  const keysToDelete = [];

  await new Promise((resolve, reject) => {
    stream.on('data', keys => keysToDelete.push(...keys));
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  if (keysToDelete.length > 0) {
    // Delete in batches of 100 to avoid oversized commands
    for (let i = 0; i < keysToDelete.length; i += 100) {
      await redis.del(...keysToDelete.slice(i, i + 100));
    }
  }

  return keysToDelete.length;
}
