import { ObjectId } from 'mongodb';
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
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { getToolsBucket } from '../../db/gridfs.js';

const UPLOADS_DIR = join(process.cwd(), 'uploads', 'payments');

function ensureUploadsDir() {
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

export async function adminSystemRoutes(fastify) {
  // ── GET /v1/admin/system — full runtime config ─────────────────────────────
  fastify.get('/v1/admin/system', async () => {
    const cfg = await getAllSystemConfig();
    // Parse booleans and numbers for convenience
    return {
      maintenance_mode:        cfg.maintenance_mode        === '1',
      generation_enabled:      cfg.generation_enabled      === '1',
      registration_enabled:    cfg.registration_enabled    === '1',
      hivemind_enabled:        cfg.hivemind_enabled        !== '0',
      default_per_min:         parseInt(cfg.default_per_min,         10) || 60,
      alert_failure_threshold: parseInt(cfg.alert_failure_threshold, 10) || 10,
      alert_queue_threshold:   parseInt(cfg.alert_queue_threshold,   10) || 100,
      alert_pool_low_threshold:parseInt(cfg.alert_pool_low_threshold,10) || 5,
      gen_temperature:         cfg.gen_temperature ? Number(cfg.gen_temperature) : null,
      gen_max_tokens:          cfg.gen_max_tokens  ? parseInt(cfg.gen_max_tokens, 10) : null,
      max_sessions_user:       parseInt(cfg.max_sessions_user,  10) || 1,
      max_sessions_admin:      parseInt(cfg.max_sessions_admin, 10) || 3,
      payment_upi_1:           cfg.payment_upi_1 || '',
      payment_upi_2:           cfg.payment_upi_2 || '',
      payment_qr_path:         cfg.payment_qr_path || '',
      payment_qr_file_id:      cfg.payment_qr_file_id || '',
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
          hivemind_enabled:        { type: 'boolean' },
          default_per_min:         { type: 'integer', minimum: 1 },
          alert_failure_threshold: { type: 'integer', minimum: 1 },
          alert_queue_threshold:   { type: 'integer', minimum: 1 },
          alert_pool_low_threshold:{ type: 'integer', minimum: 1 },
          gen_temperature:         { oneOf: [{ type: 'number', minimum: 0, maximum: 2 }, { type: 'null' }] },
          gen_max_tokens:          { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
          max_sessions_user:       { type: 'integer', minimum: 1 },
          max_sessions_admin:      { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const updates = {};
    for (const [k, v] of Object.entries(request.body)) {
      if (v === null) {
        updates[k] = '';
      } else {
        updates[k] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
      }
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

  // ── PATCH /v1/admin/system/payment — update UPI IDs ────────────────────────
  fastify.patch('/v1/admin/system/payment', {
    schema: {
      body: {
        type: 'object',
        properties: {
          upi_1: { type: 'string', maxLength: 100 },
          upi_2: { type: 'string', maxLength: 100 },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const { upi_1, upi_2 } = request.body;
    const updates = {};
    if (upi_1 !== undefined) updates.payment_upi_1 = upi_1;
    if (upi_2 !== undefined) updates.payment_upi_2 = upi_2;
    
    await setSystemConfig(updates);
    writeAuditLog({ actorEmail: request.user.email, action: 'payment_config_update', meta: request.body });
    return { updated: true, ...request.body };
  });

  // ── POST /v1/admin/system/payment-qr — upload QR code ──────────────────────
  fastify.post('/v1/admin/system/payment-qr', async (request, reply) => {
    if (!request.isMultipart) {
      reply.status(400);
      return { error: 'Multipart request required', code: 'NOT_MULTIPART' };
    }

    const part = await request.file();
    if (!part) {
      reply.status(400);
      return { error: 'No file uploaded', code: 'NO_FILE' };
    }

    const ext = extname(part.filename).toLowerCase();
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    if (!allowed.includes(ext)) {
      reply.status(400);
      return { error: 'Only image files (jpg, png, webp) are allowed', code: 'INVALID_TYPE' };
    }

    const cfg = await getAllSystemConfig();
    const bucket = await getToolsBucket();

    // 1. Clean up old GridFS file if exists
    if (cfg.payment_qr_file_id) {
      try { await bucket.delete(new ObjectId(cfg.payment_qr_file_id)); } catch {}
    }

    // 2. Clean up old disk QR if exists (Legacy)
    if (cfg.payment_qr_path && existsSync(cfg.payment_qr_path)) {
      try { unlinkSync(cfg.payment_qr_path); } catch {}
    }

    // 3. Stream to GridFS
    const uploadStream = bucket.openUploadStream(part.filename, {
      contentType: part.mimetype,
      metadata: { type: 'payment_qr', originalName: part.filename }
    });

    await new Promise((res, rej) => {
      part.file.pipe(uploadStream);
      uploadStream.on('finish', res);
      uploadStream.on('error', rej);
    });

    const fileId = uploadStream.id.toString();

    // 4. Update config
    await setSystemConfig({ 
      payment_qr_file_id: fileId,
      payment_qr_path: '' // Clear legacy path
    });

    writeAuditLog({ actorEmail: request.user.email, action: 'payment_qr_upload', meta: { filename: part.filename, fileId } });
    
    return { success: true, filename: part.filename, fileId };
  });

  // ── DELETE /v1/admin/system/payment-qr — remove QR code ────────────────────
  fastify.delete('/v1/admin/system/payment-qr', async (request) => {
    const cfg = await getAllSystemConfig();
    const bucket = await getToolsBucket();

    // 1. Clean up GridFS file if exists
    if (cfg.payment_qr_file_id) {
      try { await bucket.delete(new ObjectId(cfg.payment_qr_file_id)); } catch {}
    }

    // 2. Clean up legacy disk file if exists
    if (cfg.payment_qr_path && existsSync(cfg.payment_qr_path)) {
      try { unlinkSync(cfg.payment_qr_path); } catch {}
    }

    // 3. Update config
    await setSystemConfig({ 
      payment_qr_file_id: '', 
      payment_qr_path: '' 
    });

    writeAuditLog({ actorEmail: request.user.email, action: 'payment_qr_delete' });
    return { success: true };
  });


  // ── GET /v1/admin/system/emails — email notification status ────────────────
  fastify.get('/v1/admin/system/emails', async () => {
    const cfg = await getAllSystemConfig();
    return {
      security:    cfg.email_security_enabled     === '1',
      status:      cfg.email_status_enabled       === '1',
      tickets:     cfg.email_tickets_enabled      === '1',
      quota:       cfg.email_quota_enabled        === '1',
      admin_health:cfg.email_admin_alerts_enabled === '1',
      otp:         true, // Always ON, non-toggleable
    };
  });

  // ── PATCH /v1/admin/system/emails — update email toggles ───────────────────
  fastify.patch('/v1/admin/system/emails', {
    schema: {
      body: {
        type: 'object',
        properties: {
          security:     { type: 'boolean' },
          status:       { type: 'boolean' },
          tickets:      { type: 'boolean' },
          quota:        { type: 'boolean' },
          admin_health: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const updates = {};
    if (request.body.security     !== undefined) updates.email_security_enabled     = request.body.security     ? '1' : '0';
    if (request.body.status       !== undefined) updates.email_status_enabled       = request.body.status       ? '1' : '0';
    if (request.body.tickets      !== undefined) updates.email_tickets_enabled      = request.body.tickets      ? '1' : '0';
    if (request.body.quota        !== undefined) updates.email_quota_enabled        = request.body.quota        ? '1' : '0';
    if (request.body.admin_health !== undefined) updates.email_admin_alerts_enabled = request.body.admin_health ? '1' : '0';

    if (Object.keys(updates).length > 0) {
      await setSystemConfig(updates);
    }

    writeAuditLog({ actorEmail: request.user.email, action: 'email_config_update', meta: request.body });
    return { updated: true, ...request.body };
  });
}
