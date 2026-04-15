import { randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { getRedis } from '../redis/client.js';
import { config } from '../config.js';

const SESSION_PREFIX = 'session:';

function sessionKey(email) {
  return `${SESSION_PREFIX}${email}`;
}

/**
 * Create a new session for the user.
 * - Generates a unique sessionId
 * - Overwrites any existing session in Redis (single-device enforcement)
 * - Returns a signed JWT containing { email, sessionId, role }
 *
 * @param {string} email
 * @param {string} [role='user']
 * @param {string} [plan='free']
 * @returns {{ token: string, hadPreviousSession: boolean }}
 */
export async function createSession(email, role = 'user', plan = 'free') {
  const redis = getRedis();
  const sessionId = randomBytes(32).toString('hex');

  // Check if there's an existing session (another device)
  const existing = await redis.get(sessionKey(email));

  // Store new session — overwrite previous, with TTL matching the JWT expiry
  // so the Redis key is automatically cleaned up when the token is no longer valid.
  const ttlSeconds = parseDurationToSeconds(config.jwtExpiresIn);
  await redis.set(sessionKey(email), sessionId, 'EX', ttlSeconds);

  const token = jwt.sign(
    { email, sessionId, role, plan },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  return { token, hadPreviousSession: !!existing };
}

/**
 * Validate a JWT token and verify the session is still active.
 * Returns { valid: true, email, sessionId } or { valid: false, reason }
 */
export async function validateSession(token) {
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    return { valid: false, reason: err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token' };
  }

  const { email, sessionId, role, plan } = payload;

  // Check Redis — session must match (single-device check)
  const stored = await getRedis().get(sessionKey(email));

  if (!stored) {
    return { valid: false, reason: 'session_not_found' };
  }

  if (stored !== sessionId) {
    return { valid: false, reason: 'session_superseded' }; // logged in elsewhere
  }

  return { valid: true, email, sessionId, role: role ?? 'user', plan: plan ?? 'free' };
}

/**
 * Invalidate the current session for a user (logout).
 */
export async function invalidateSession(email) {
  await getRedis().del(sessionKey(email));
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
