import { createOtpValue, persistOtp, verifyOtp } from '../auth/otp.js';
import { createSession, invalidateSession } from '../auth/session.js';
import { sendEmail } from '../services/email.js';
// Removed: import { otpTemplate } from '../services/emailTemplates.js';

import { notifyNewDeviceLogin, notifySessionInvalidated } from '../services/notifications.js';
import { authenticate } from '../auth/middleware.js';
import { getOrCreateUser, getUser, updatePreviousOtp } from '../db/users.js';
import { config } from '../config.js';
import { isEmailAllowed } from '../db/whitelist.js';
import { isRegistrationEnabled } from '../redis/systemConfig.js';
import { getRedis } from '../redis/client.js';


/**
 * Redis-backed throttle. Increments key and sets TTL on first hit.
 * Returns true if the request is allowed, false if the limit is exceeded.
 * Fails open (returns true) if Redis is unavailable.
 */
async function throttle(key, limit, windowSeconds, log) {
  try {
    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    return count <= limit;
  } catch (err) {
    log?.warn({ err, key }, '[auth] throttle redis error — failing open');
    return true;
  }
}

async function authThrottlePreHandler(request, reply, scope, ipLimit, ipWindow, emailLimit, emailWindow) {
  const ip = request.ip || 'unknown';
  const email = (request.body?.email || '').toLowerCase();

  const ipOk = await throttle(`auth_throttle:${scope}:ip:${ip}`, ipLimit, ipWindow, request.log);
  if (!ipOk) {
    reply.status(429);
    return reply.send({ error: 'Too many requests from this IP. Please try again later.', code: 'RATE_LIMITED' });
  }

  if (email) {
    const emailOk = await throttle(`auth_throttle:${scope}:email:${email}`, emailLimit, emailWindow, request.log);
    if (!emailOk) {
      reply.status(429);
      return reply.send({ error: 'Too many requests for this email. Please try again later.', code: 'RATE_LIMITED' });
    }
  }
}

export async function authRoutes(fastify) {
  // ── Step 1: Request OTP ──────────────────────────────────────────────────
  fastify.post('/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
        },
      },
    },
    preHandler: (request, reply) =>
      // 5 requests per IP per minute, 3 OTPs per email per 10 minutes
      authThrottlePreHandler(request, reply, 'login', 5, 60, 3, 600),
  }, async (request, reply) => {
    const { email } = request.body;

    // Check if registration/login is enabled
    const registrationOn = await isRegistrationEnabled();
    if (!registrationOn) {
      reply.status(503);
      return { error: 'New sign-ins are temporarily disabled by the administrator.', code: 'REGISTRATION_DISABLED' };
    }

    // Check whitelist — fails open if DB is unavailable
    const allowed = await isEmailAllowed(email);
    if (!allowed) {
      reply.status(403);
      return { error: 'This email address is not authorised to access this service.', code: 'NOT_WHITELISTED' };
    }

    const existingUser = await getUser(email);
    const isNewUser = !existingUser;

    let otp = null;
    let isPrevious = false;

    // If opted-in, check if there's a valid previous OTP to reuse
    if (existingUser?.allow_previous_otp && existingUser.previous_otp) {
      const now = new Date();
      const expiry = existingUser.previous_otp_expires_at ? new Date(existingUser.previous_otp_expires_at) : null;
      if (expiry && expiry > now) {
        otp = existingUser.previous_otp;
        isPrevious = true;
      }
    }

    // Generate new OTP if none exists or previous is expired/disabled
    if (!otp) {
      otp = createOtpValue();
    }

    try {
      await sendEmail(email, 'otp', { otp });
    } catch (err) {
      fastify.log.error({ err }, '[auth] failed to send OTP email');
      reply.status(502);
      return { error: 'Failed to send OTP email', code: 'EMAIL_ERROR' };
    }

    // Email succeeded → persist OTP to Redis.
    await persistOtp(email, otp);

    return { 
      message: isPrevious 
        ? 'Your previous OTP has been sent to your email. It remains valid for the 3-day window.'
        : 'OTP sent to your email. It expires in 10 minutes.',
      isNewUser 
    };
  });

  // ── Step 2: Verify OTP → receive JWT ────────────────────────────────────
  fastify.post('/auth/verify', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'otp'],
        properties: {
          email: { type: 'string', format: 'email' },
          otp:   { type: 'string', minLength: 6, maxLength: 6, pattern: '^[0-9]{6}$' },
          referralCode: { type: 'string' },
        },
      },
    },
    preHandler: (request, reply) =>
      // 10 attempts per IP per minute, 10 attempts per email per 10 minutes
      authThrottlePreHandler(request, reply, 'verify', 10, 60, 10, 600),
  }, async (request, reply) => {
    const { email, otp, referralCode } = request.body;

    const result = await verifyOtp(email, otp);
    let authResult = result;

    // If OTP is invalid, check if user has previous OTP enabled and it matches
    if (!authResult.valid) {
      const user = await getUser(email);
      if (user?.allow_previous_otp && user.previous_otp === otp) {
        const now = new Date();
        const expiry = user.previous_otp_expires_at ? new Date(user.previous_otp_expires_at) : null;
        
        if (expiry && expiry > now) {
          authResult = { valid: true, isPrevious: true };
        }
      }
    }

    if (!authResult.valid) {
      reply.status(401);
      return { error: authResult.reason, code: 'OTP_INVALID' };
    }

    // Upsert user document — creates with role:'user' if first login
    const userDoc = await getOrCreateUser(email, referralCode);

    // If they logged in with a FRESH OTP, update their previous_otp for next time
    if (!authResult.isPrevious) {
      await updatePreviousOtp(email, otp);
    }

    const role = userDoc?.role ?? 'user';

    // Create new session — enforces limit (1 for user, 3 for admin/owner)
    const { token, wasSuperseded } = await createSession(email, role, userDoc?.plan ?? 'free');

    if (wasSuperseded) {
      notifySessionInvalidated(email);
    } else {
      notifyNewDeviceLogin(email);
    }

    return {
      token,
      message: wasSuperseded
        ? 'Logged in. Your oldest session on another device has been invalidated.'
        : 'Logged in successfully.',
    };
  });

  fastify.post('/auth/logout', {
    preHandler: authenticate,
  }, async (request) => {
    // Only invalidate THIS session ID (this device), not all of them
    await invalidateSession(request.user.email, request.user.sessionId);
    return { message: 'Logged out successfully.' };
  });

  // ── Me (current user info) ────────────────────────────────────────────────
  fastify.get('/auth/me', {
    preHandler: authenticate,
  }, async (request) => {
    return { email: request.user.email, role: request.user.role };
  });
}
