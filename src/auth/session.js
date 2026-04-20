import { randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { getRedis } from '../redis/client.js';
import { config } from '../config.js';
import { getMaxSessionsUser, getMaxSessionsAdmin } from '../redis/systemConfig.js';

const SESSION_PREFIX = 'sessions:v2:'; // Using v2 prefix to avoid collisions with old session keys

function sessionKey(email) {
  return `${SESSION_PREFIX}${email}`;
}

// Lua script: atomically ZADD + EXPIRE + ZREMRANGEBYRANK to prevent
// race conditions where concurrent logins exceed the session limit.
const CREATE_SESSION_LUA = `
  local key = KEYS[1]
  local score = tonumber(ARGV[1])
  local sessionId = ARGV[2]
  local ttl = tonumber(ARGV[3])
  local limit = tonumber(ARGV[4])
  redis.call('ZADD', key, score, sessionId)
  redis.call('EXPIRE', key, ttl)
  local removed = redis.call('ZREMRANGEBYRANK', key, 0, -(limit + 1))
  return removed
`;

/**
 * Create a new session for the user.
 * - Generates a unique sessionId
 * - Stores in a Redis Sorted Set (ZSET) to allow multiple devices
 * - Enforces limits: 3 for admins/owners, 1 for regular users
 * - Returns a signed JWT and whether the oldest session was kicked out
 *
 * @param {string} email
 * @param {string} [role='user']
 * @param {string} [plan='free']
 * @returns {{ token: string, wasSuperseded: boolean }}
 */
export async function createSession(email, role = 'user', plan = 'free') {
  const redis = getRedis();
  const sessionId = randomBytes(32).toString('hex');
  const key = sessionKey(email);
  const now = Date.now();

  // Role-based session limits
  const limit = (role === 'admin' || role === 'owner') 
    ? await getMaxSessionsAdmin() 
    : await getMaxSessionsUser();

  const ttlSeconds = parseDurationToSeconds(config.jwtExpiresIn);

  // Atomic: ZADD + EXPIRE + ZREMRANGEBYRANK in a single Lua call
  const removedCount = await redis.eval(CREATE_SESSION_LUA, 1, key, now, sessionId, ttlSeconds, limit);

  const token = jwt.sign(
    { email, sessionId, role, plan },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  return { token, wasSuperseded: removedCount > 0 };
}

/**
 * Validate a JWT token and verify the specific session is still active in Redis.
 * Returns { valid: true, ... } or { valid: false, reason }
 */
export async function validateSession(token) {
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    return { valid: false, reason: err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token' };
  }

  const { email, sessionId, role, plan } = payload;
  const key = sessionKey(email);

  // Check if this specific sessionId still exists in the Sorted Set
  const score = await getRedis().zscore(key, sessionId);

  if (!score) {
    // Session was either never created, manually logged out, 
    // or superseded by a newer device/expired.
    return { valid: false, reason: 'session_invalid_or_superseded' };
  }

  // Optional: update timestamp to keep session at the "top" of the stack (sliding window)
  // await getRedis().zadd(key, Date.now(), sessionId);

  return { valid: true, email, sessionId, role: role ?? 'user', plan: plan ?? 'free' };
}

/**
 * Invalidate session(s) for a user.
 * @param {string} email
 * @param {string} [sessionId] - if provided, only that specific device is logged out.
 *                               if null, ALL devices for this user are logged out.
 */
export async function invalidateSession(email, sessionId = null) {
  const redis = getRedis();
  const key = sessionKey(email);
  if (sessionId) {
    await redis.zrem(key, sessionId);
  } else {
    await redis.del(key);
  }
}

/**
 * Parse a JWT-style duration string (e.g. '7d', '24h', '30m', '3600s', or plain seconds)
 * into seconds. Defaults to 86400 (24h) on unrecognised input.
 */
function parseDurationToSeconds(val) {
  if (typeof val === 'number') return val;
  const match = String(val).match(/^(\d+)(d|h|m|s)?$/i);
  if (!match) return 86400;
  const n = parseInt(match[1], 10);
  switch ((match[2] || 's').toLowerCase()) {
    case 'd': return n * 86400;
    case 'h': return n * 3600;
    case 'm': return n * 60;
    default:  return n;
  }
}
