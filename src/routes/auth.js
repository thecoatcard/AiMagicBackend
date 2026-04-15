import { generateOtp, verifyOtp } from '../auth/otp.js';
import { createSession, invalidateSession } from '../auth/session.js';
import { sendEmail } from '../services/email.js';
// Removed: import { otpTemplate } from '../services/emailTemplates.js';

import { notifyNewDeviceLogin, notifySessionInvalidated } from '../services/notifications.js';
import { authenticate } from '../auth/middleware.js';
import { getOrCreateUser } from '../db/users.js';
import { config } from '../config.js';
import { isEmailAllowed } from '../db/whitelist.js';
import { isRegistrationEnabled } from '../redis/systemConfig.js';

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

    const otp = await generateOtp(email);

    try {
      await sendEmail(email, 'otp', { otp });
    } catch (err) {

      fastify.log.error({ err }, '[auth] failed to send OTP email');
      reply.status(502);
      return { error: 'Failed to send OTP email', code: 'EMAIL_ERROR' };
    }

    return { message: 'OTP sent to your email. It expires in 10 minutes.' };
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
        },
      },
    },
  }, async (request, reply) => {
    const { email, otp } = request.body;

    const result = await verifyOtp(email, otp);

    if (!result.valid) {
      reply.status(401);
      return { error: result.reason, code: 'OTP_INVALID' };
    }

    // Upsert user document — creates with role:'user' if first login
    const userDoc = await getOrCreateUser(email);
    const role = userDoc?.role ?? 'user';

    // Create new session — auto-invalidates any existing session (other device)
    const { token, hadPreviousSession } = await createSession(email, role, userDoc?.plan ?? 'free');

    // One email per login — combined if a previous session was ended, plain new-sign-in otherwise
    if (hadPreviousSession) {
      notifySessionInvalidated(email);
    } else {
      notifyNewDeviceLogin(email);
    }

    return {
      token,
      message: hadPreviousSession
        ? 'Logged in. Previous session on another device has been invalidated.'
        : 'Logged in successfully.',
    };
  });

  // ── Logout ───────────────────────────────────────────────────────────────
  fastify.post('/auth/logout', {
    preHandler: authenticate,
  }, async (request) => {
    await invalidateSession(request.user.email);
    return { message: 'Logged out successfully.' };
  });

  // ── Me (current user info) ────────────────────────────────────────────────
  fastify.get('/auth/me', {
    preHandler: authenticate,
  }, async (request) => {
    return { email: request.user.email, role: request.user.role };
  });
}
