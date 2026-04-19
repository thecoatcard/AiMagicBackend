import {
  getUser,
  listUsers,
  listUsersFiltered,
  getUserStats,
  bulkUpdateUsers,
  setUserRole,
  setUserStatus,
  setUserLimits,
  setUserPlan,
  deleteUser,
} from '../db/users.js';
import { requireAdmin, requireOwner } from '../auth/roles.js';
import { invalidateUserLimitsCache } from '../middleware/rateLimiter.js';
import { invalidateSession } from '../auth/session.js';
import { config } from '../config.js';
import { ASSIGNABLE_PLANS } from '../config/plans.js';
import { getPlanDailyLimit } from '../redis/systemConfig.js';
import {
  notifyAccountBlocked,
  notifyAccountUnblocked,
  notifyPlanChanged,
} from '../services/notifications.js';
import { writeAuditLog } from '../db/auditLog.js';

export async function usersRoutes(fastify) {
  // ── GET /v1/users/me — own profile (any authenticated user) ────────────────
  // NOTE: must be registered before the /:email param route
  fastify.get('/v1/users/me', async (request) => {
    const user = await getUser(request.user.email);
    // Fall back gracefully if DB is unavailable
    return user ?? {
      email:  request.user.email,
      role:   request.user.role,
      status: 'active',
    };
  });

  // ── GET /v1/users — list all users with search/filter (admin only) ───────────
  fastify.get('/v1/users', {
    preHandler: requireAdmin,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          skip:   { type: 'integer', minimum: 0, default: 0 },
          role:   { type: 'string', enum: ['user', 'admin', 'owner'] },
          plan:   { type: 'string', enum: ASSIGNABLE_PLANS },
          status: { type: 'string', enum: ['active', 'blocked'] },
          email:  { type: 'string' },
          sort:   { type: 'string', enum: ['created', 'email', 'usage'], default: 'created' },
        },
      },
    },
  }, async (request) => {
    const { limit, skip, role, plan, status, email, sort } = request.query;
    // Only filter if any filter param was provided
    const hasFilter = role || plan || status || email || sort !== 'created';
    if (hasFilter) {
      return await listUsersFiltered({ limit, skip, role, plan, status, email, sort });
    }
    return await listUsers({ limit, skip });
  });

  // ── GET /v1/users/stats — aggregate user statistics (owner only) ──────────
  fastify.get('/v1/users/stats', {
    preHandler: requireAdmin,
  }, async (request, reply) => {
    try {
      return await getUserStats();
    } catch {
      reply.status(503);
      return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }
  });

  // ── POST /v1/users/bulk — bulk operations on multiple users (admin only) ───
  fastify.post('/v1/users/bulk', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['emails', 'action'],
        properties: {
          emails: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
          action: { type: 'string', enum: ['block', 'unblock', 'set_plan'] },
          plan:   { type: 'string', enum: ASSIGNABLE_PLANS },
        },
      },
    },
  }, async (request, reply) => {
    const { emails, action, plan } = request.body;

    // Prevent operating on own account or owner account
    const safeEmails = emails.filter(e => e !== request.user.email && e !== config.ownerEmail);
    if (safeEmails.length === 0) {
      reply.status(400);
      return { error: 'No eligible users in the provided list', code: 'NO_ELIGIBLE_USERS' };
    }

    let result;
    if (action === 'block') {
      result = await bulkUpdateUsers(safeEmails, { status: 'blocked' });
      // Invalidate sessions for all blocked users
      await Promise.all(safeEmails.map(e => invalidateSession(e).catch(() => {})));
    } else if (action === 'unblock') {
      result = await bulkUpdateUsers(safeEmails, { status: 'active' });
    } else if (action === 'set_plan') {
      if (!plan) {
        reply.status(400);
        return { error: 'plan is required for set_plan action', code: 'MISSING_PLAN' };
      }
      result = await bulkUpdateUsers(safeEmails, { plan });
      // Bust caches for all affected users
      await Promise.all(safeEmails.map(e => invalidateUserLimitsCache(e).catch(() => {})));
    }

    writeAuditLog({
      actorEmail: request.user.email,
      action:     `bulk_${action}`,
      meta:       { emails: safeEmails, plan },
    });

    return { ...result, action, emails: safeEmails };
  });

  // ── GET /v1/users/:email — single user detail (admin only) ─────────────────
  fastify.get('/v1/users/:email', {
    preHandler: requireAdmin,
  }, async (request, reply) => {
    const email = decodeURIComponent(request.params.email);
    const user = await getUser(email);
    if (!user) {
      reply.status(404);
      return { error: 'User not found', email };
    }
    return user;
  });

  // ── POST /v1/users/:email/impersonate — create short-lived impersonation token (owner only)
  fastify.post('/v1/users/:email/impersonate', {
    preHandler: requireOwner,
  }, async (request, reply) => {
    const email = decodeURIComponent(request.params.email);
    if (email === request.user.email) {
      reply.status(400);
      return { error: 'Cannot impersonate your own account', code: 'INVALID' };
    }
    const user = await getUser(email);
    if (!user) {
      reply.status(404);
      return { error: 'User not found', email };
    }
    // Import jwt directly for a custom short-lived token
    const { default: jwt } = await import('jsonwebtoken');
    const { config: cfg } = await import('../config.js');
    const token = jwt.sign(
      { email, role: user.role, impersonated: true, impersonator: request.user.email },
      cfg.jwtSecret,
      { expiresIn: '1h' }
    );
    writeAuditLog({
      actorEmail:  request.user.email,
      action:      'impersonate',
      targetEmail: email,
      meta:        { target_role: user.role },
    });
    return { token, expires_in: '1h', impersonating: email };
  });

  // ── PATCH /v1/users/:email/block — block a user (admin only) ───────────────
  fastify.patch('/v1/users/:email/block', {
    preHandler: requireAdmin,
  }, async (request, reply) => {
    const email = decodeURIComponent(request.params.email);
    if (email === request.user.email) {
      reply.status(403);
      return { error: 'Cannot block your own account', code: 'FORBIDDEN' };
    }
    if (config.ownerEmail && email === config.ownerEmail) {
      reply.status(403);
      return { error: 'Cannot block the owner account', code: 'FORBIDDEN' };
    }
    const found = await setUserStatus(email, 'blocked');
    if (!found) {
      reply.status(404);
      return { error: 'User not found', email };
    }
    // Force the blocked user offline immediately
    await invalidateSession(email);
    notifyAccountBlocked(email);
    writeAuditLog({ actorEmail: request.user.email, action: 'block_user', targetEmail: email });
    return { updated: true, email, status: 'blocked' };
  });

  // ── PATCH /v1/users/:email/unblock — unblock a user (admin only) ───────────
  fastify.patch('/v1/users/:email/unblock', {
    preHandler: requireAdmin,
  }, async (request, reply) => {
    const email = decodeURIComponent(request.params.email);
    const found = await setUserStatus(email, 'active');
    if (!found) {
      reply.status(404);
      return { error: 'User not found', email };
    }
    notifyAccountUnblocked(email);
    writeAuditLog({ actorEmail: request.user.email, action: 'unblock_user', targetEmail: email });
    return { updated: true, email, status: 'active' };
  });

  // ── PATCH /v1/users/:email/limits — set rate limits (admin only) ───────────
  fastify.patch('/v1/users/:email/limits', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        minProperties: 1,
        properties: {
          max_requests_per_min: { type: 'integer', minimum: 1 },
          max_requests_per_day: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const email = decodeURIComponent(request.params.email);
    const found = await setUserLimits(email, request.body);
    if (!found) {
      reply.status(404);
      return { error: 'User not found', email };
    }
    // Bust Redis cache so new limits apply immediately
    await invalidateUserLimitsCache(email);
    return { updated: true, email, limits: request.body };
  });

  // ── PATCH /v1/users/:email/role — change role (owner only) ─────────────────
  fastify.patch('/v1/users/:email/role', {
    preHandler: requireOwner,
    schema: {
      body: {
        type: 'object',
        required: ['role'],
        properties: {
          role: { type: 'string', enum: ['user', 'admin'] },
        },
      },
    },
  }, async (request, reply) => {
    const email = decodeURIComponent(request.params.email);
    if (email === request.user.email) {
      reply.status(403);
      return { error: 'Cannot change your own role', code: 'FORBIDDEN' };
    }
    if (config.ownerEmail && email === config.ownerEmail) {
      reply.status(403);
      return { error: 'Cannot change the owner role via API', code: 'FORBIDDEN' };
    }
    const found = await setUserRole(email, request.body.role);
    if (!found) {
      reply.status(404);
      return { error: 'User not found', email };
    }
    // Force re-login so the new role takes effect immediately (Bug 1 fix)
    await invalidateSession(email);
    writeAuditLog({ actorEmail: request.user.email, action: 'change_role', targetEmail: email, meta: { role: request.body.role } });
    return { updated: true, email, role: request.body.role };
  });

  // ── PATCH /v1/users/:email/plan — change plan (admin/owner only) ───────────
  fastify.patch('/v1/users/:email/plan', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['plan'],
        properties: {
          plan: { type: 'string', enum: ASSIGNABLE_PLANS },
        },
      },
    },
  }, async (request, reply) => {
    const email = decodeURIComponent(request.params.email);
    const { plan } = request.body;
    // Fetch old plan before overwriting so the notification shows the change
    const existingUser = await getUser(email);
    const found = await setUserPlan(email, plan);
    if (!found) {
      reply.status(404);
      return { error: 'User not found', email };
    }
    // Bust Redis cache so new plan limit takes effect immediately
    await invalidateUserLimitsCache(email);
    notifyPlanChanged(email, {
      oldPlan:  existingUser?.plan ?? 'free',
      newPlan:  plan,
      newLimit: await getPlanDailyLimit(plan),
    });
    return { updated: true, email, plan };
  });

  // ── DELETE /v1/users/:email — remove user (admin only) ────────────────────
  fastify.delete('/v1/users/:email', {
    preHandler: requireAdmin,
  }, async (request, reply) => {
    const email = decodeURIComponent(request.params.email);
    if (email === request.user.email) {
      reply.status(403);
      return { error: 'Cannot delete your own account', code: 'FORBIDDEN' };
    }
    if (config.ownerEmail && email === config.ownerEmail) {
      reply.status(403);
      return { error: 'Cannot delete the owner account', code: 'FORBIDDEN' };
    }
    const found = await deleteUser(email);
    if (!found) {
      reply.status(404);
      return { error: 'User not found', email };
    }
    // Invalidate session so the deleted user is logged out immediately
    await invalidateSession(email);
    reply.status(204);
    return '';
  });
}
