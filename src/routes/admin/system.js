import {
  getAllSystemConfig,
  setSystemConfig,
  bustAllUserCaches,
} from '../../redis/systemConfig.js';
import { PLANS, ASSIGNABLE_PLANS } from '../../config/plans.js';
import {
  listWhitelist,
  addWhitelistRule,
  removeWhitelistRule,
} from '../../db/whitelist.js';
import { writeAuditLog } from '../../db/auditLog.js';

export async function adminSystemRoutes(fastify) {
  // ── GET /v1/admin/system — full runtime config ─────────────────────────────
  fastify.get('/v1/admin/system', async () => {
    const cfg = await getAllSystemConfig();
    // Parse booleans and numbers for convenience
    return {
      maintenance_mode:        cfg.maintenance_mode        === '1',
      generation_enabled:      cfg.generation_enabled      === '1',
      registration_enabled:    cfg.registration_enabled    === '1',
      default_per_min:         parseInt(cfg.default_per_min,         10) || 60,
      alert_failure_threshold: parseInt(cfg.alert_failure_threshold, 10) || 10,
      alert_queue_threshold:   parseInt(cfg.alert_queue_threshold,   10) || 100,
      alert_pool_low_threshold:parseInt(cfg.alert_pool_low_threshold,10) || 5,
      gen_temperature:         cfg.gen_temperature ? Number(cfg.gen_temperature) : null,
      gen_max_tokens:          cfg.gen_max_tokens  ? parseInt(cfg.gen_max_tokens, 10) : null,
    };
  });

  // ── PATCH /v1/admin/system — update runtime flags ─────────────────────────
  fastify.patch('/v1/admin/system', {
    schema: {
      body: {
        type: 'object',
        minProperties: 1,
        properties: {
          maintenance_mode:        { type: 'boolean' },
          generation_enabled:      { type: 'boolean' },
          registration_enabled:    { type: 'boolean' },
          default_per_min:         { type: 'integer', minimum: 1 },
          alert_failure_threshold: { type: 'integer', minimum: 1 },
          alert_queue_threshold:   { type: 'integer', minimum: 1 },
          alert_pool_low_threshold:{ type: 'integer', minimum: 1 },
          gen_temperature:         { type: 'number',  minimum: 0, maximum: 2 },
          gen_max_tokens:          { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const updates = {};
    for (const [k, v] of Object.entries(request.body)) {
      updates[k] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    }
    await setSystemConfig(updates);

    // Bust all user caches when global per-min limit changes
    if ('default_per_min' in request.body) {
      await bustAllUserCaches();
    }

    writeAuditLog({ actorEmail: request.user.email, action: 'system_config_update', meta: request.body });
    return { updated: true, changes: request.body };
  });

  // ── GET /v1/admin/system/plan-limits — current plan limits ─────────────────
  fastify.get('/v1/admin/system/plan-limits', async () => {
    const cfg = await getAllSystemConfig();
    const limits = {};
    for (const plan of ASSIGNABLE_PLANS) {
      const key = `plan_limit_${plan}`;
      limits[plan] = {
        label:          PLANS[plan]?.label ?? plan,
        daily_requests: parseInt(cfg[key], 10) || PLANS[plan]?.daily_requests,
      };
    }
    return limits;
  });

  // ── PATCH /v1/admin/system/plan-limits — update a plan's daily request limit
  fastify.patch('/v1/admin/system/plan-limits', {
    schema: {
      body: {
        type: 'object',
        required: ['plan', 'daily_requests'],
        properties: {
          plan:           { type: 'string', enum: ASSIGNABLE_PLANS },
          daily_requests: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const { plan, daily_requests } = request.body;
    await setSystemConfig({ [`plan_limit_${plan}`]: String(daily_requests) });
    // Bust caches so new limits take effect within seconds
    const busted = await bustAllUserCaches();
    writeAuditLog({
      actorEmail: request.user.email,
      action:     'plan_limit_update',
      meta:       { plan, daily_requests, caches_busted: busted },
    });
    return { updated: true, plan, daily_requests, caches_busted: busted };
  });

  // ── GET /v1/admin/whitelist — list whitelist rules ─────────────────────────
  fastify.get('/v1/admin/whitelist', async (request, reply) => {
    try {
      return await listWhitelist();
    } catch {
      reply.status(503);
      return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }
  });

  // ── POST /v1/admin/whitelist — add a rule ──────────────────────────────────
  fastify.post('/v1/admin/whitelist', {
    schema: {
      body: {
        type: 'object',
        required: ['type', 'value'],
        properties: {
          type:  { type: 'string', enum: ['email', 'domain'] },
          value: { type: 'string', minLength: 1, maxLength: 200 },
          note:  { type: 'string', maxLength: 500 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { type, value, note } = request.body;
    const result = await addWhitelistRule(type, value, note);
    if (!result.added) {
      reply.status(409);
      return { error: 'Rule already exists', reason: result.reason };
    }
    writeAuditLog({ actorEmail: request.user.email, action: 'whitelist_add', meta: { type, value } });
    reply.status(201);
    return { added: true, type, value };
  });

  // ── DELETE /v1/admin/whitelist — remove a rule ─────────────────────────────
  fastify.delete('/v1/admin/whitelist', {
    schema: {
      body: {
        type: 'object',
        required: ['type', 'value'],
        properties: {
          type:  { type: 'string', enum: ['email', 'domain'] },
          value: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { type, value } = request.body;
    const removed = await removeWhitelistRule(type, value);
    if (!removed) {
      reply.status(404);
      return { error: 'Rule not found' };
    }
    writeAuditLog({ actorEmail: request.user.email, action: 'whitelist_remove', meta: { type, value } });
    return { removed: true, type, value };
  });
}
