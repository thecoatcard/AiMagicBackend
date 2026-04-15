import { getRedis } from '../redis/client.js';
import { config } from '../config.js';

const OTP_PREFIX = 'otp:';
const OTP_ATTEMPTS_PREFIX = 'otp_attempts:';
const MAX_ATTEMPTS = 5;

function otpKey(email) {
  return `${OTP_PREFIX}${email}`;
}

function attemptsKey(email) {
  return `${OTP_ATTEMPTS_PREFIX}${email}`;
}

/**
 * Generate a 6-digit OTP, store it in Redis with TTL, return the OTP.
 * Overwrites any existing OTP for this email (resend case).
 */
export async function generateOtp(email) {
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const ttlSeconds = Math.ceil(config.otpTtlMs / 1000);
  const redis = getRedis();

  await redis.pipeline()
    .set(otpKey(email), otp, 'EX', ttlSeconds)
    .del(attemptsKey(email))          // reset attempt counter on new OTP
    .exec();

  return otp;
}

/**
 * Verify an OTP for an email.
 * Returns { valid: true } or { valid: false, reason }
 * Deletes the OTP on success. Increments fail counter.
 *
 * Uses a Lua script to make read-compare-delete atomic, preventing a
 * race where two concurrent requests both validate the same OTP.
 */
export async function verifyOtp(email, otp) {
  const redis = getRedis();

  // Atomic Lua script:
  //   1. Check attempt count — return -1 if locked out
  //   2. Get stored OTP — return 0 if missing/expired
  //   3. Compare OTP — return 1 if mismatch (and increment attempts)
  //   4. Delete OTP + attempts — return 2 on success
  const luaScript = `
    local attempts = tonumber(redis.call('GET', KEYS[2])) or 0
    if attempts >= tonumber(ARGV[2]) then return -1 end

    local stored = redis.call('GET', KEYS[1])
    if not stored then return 0 end

    if stored ~= ARGV[1] then
      local ttl = redis.call('TTL', KEYS[1])
      if ttl > 0 then
        redis.call('SET', KEYS[2], attempts + 1, 'EX', ttl)
      end
      return 1
    end

    redis.call('DEL', KEYS[1])
    redis.call('DEL', KEYS[2])
    return 2
  `;

  const result = await redis.eval(
    luaScript,
    2,
    otpKey(email),
    attemptsKey(email),
    String(otp),
    String(MAX_ATTEMPTS),
  );

  if (result === -1) return { valid: false, reason: 'too_many_attempts' };
  if (result === 0)  return { valid: false, reason: 'otp_expired_or_not_found' };
  if (result === 1)  return { valid: false, reason: 'invalid_otp' };
  return { valid: true };
}
