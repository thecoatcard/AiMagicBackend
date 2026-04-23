import { getRedis } from '../../redis/client.js';
import { getAllSystemConfig, setSystemConfig } from '../../redis/systemConfig.js';
import { sendEmail } from '../../services/email.js';
import { getDb } from '../../db/client.js';
import { config } from '../../config.js';
import { writeAuditLog } from '../../db/auditLog.js';
import { notifyAdminDailySummary } from '../../services/notifications.js';
import { getYesterdayBoundsIST } from '../../services/dailySnapshot.js';

export async function adminAlertsRoutes(fastify) {
  // ── GET /v1/admin/alerts/throttles — view active alert throttle keys ────────
  fastify.get('/v1/admin/alerts/throttles', async () => {
    const redis = getRedis();
    const keys = await scanKeys(redis, 'alert:*');
    if (keys.length === 0) return { throttles: [] };

    const ttls = await Promise.all(keys.map(k => redis.ttl(k)));
    const throttles = keys.map((k, i) => ({ key: k, ttl_seconds: ttls[i] }));
    return { throttles };
  });

  // ── DELETE /v1/admin/alerts/throttles — clear ALL throttle keys ─────────────
  fastify.delete('/v1/admin/alerts/throttles', async (request) => {
    const redis = getRedis();
    const keys = await scanKeys(redis, 'alert:*');
    if (keys.length > 0) {
      for (let i = 0; i < keys.length; i += 100) {
        await redis.del(...keys.slice(i, i + 100));
      }
    }
    writeAuditLog({ actorEmail: request.user.email, action: 'alert_throttles_cleared', meta: { count: keys.length } });
    return { cleared: keys.length };
  });

  // ── DELETE /v1/admin/alerts/throttles/:key — clear one throttle key ─────────
  fastify.delete('/v1/admin/alerts/throttles/:key', async (request, reply) => {
    const redis = getRedis();
    const key = `alert:${decodeURIComponent(request.params.key)}`;
    const deleted = await redis.del(key);
    if (!deleted) {
      reply.status(404);
      return { error: 'Throttle key not found' };
    }
    return { cleared: 1, key };
  });

  // ── GET /v1/admin/alerts/thresholds — current alert thresholds ──────────────
  fastify.get('/v1/admin/alerts/thresholds', async () => {
    const cfg = await getAllSystemConfig();
    return {
      alert_failure_threshold:  parseInt(cfg.alert_failure_threshold,  10) || 10,
      alert_queue_threshold:    parseInt(cfg.alert_queue_threshold,    10) || 100,
      alert_pool_low_threshold: parseInt(cfg.alert_pool_low_threshold, 10) || 5,
    };
  });

  // ── PATCH /v1/admin/alerts/thresholds — update alert thresholds ─────────────
  fastify.patch('/v1/admin/alerts/thresholds', {
    schema: {
      body: {
        type: 'object',
        minProperties: 1,
        properties: {
          alert_failure_threshold:  { type: 'integer', minimum: 1 },
          alert_queue_threshold:    { type: 'integer', minimum: 1 },
          alert_pool_low_threshold: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const updates = {};
    for (const [k, v] of Object.entries(request.body)) {
      updates[k] = String(v);
    }
    await setSystemConfig(updates);
    writeAuditLog({ actorEmail: request.user.email, action: 'alert_thresholds_update', meta: request.body });
    return { updated: true, thresholds: request.body };
  });

  // ── POST /v1/admin/alerts/test — send a test email to the owner ─────────────
  fastify.post('/v1/admin/alerts/test', async (request, reply) => {
    if (!config.ownerEmail) {
      reply.status(422);
      return { error: 'OWNER_EMAIL not configured — cannot send test email' };
    }
    try {
      await sendEmail(config.ownerEmail, 'test', { senderEmail: request.user.email });
      writeAuditLog({ actorEmail: request.user.email, action: 'test_email_sent', meta: { to: config.ownerEmail } });

      return { sent: true, to: config.ownerEmail };
    } catch (err) {
      reply.status(502);
      return { error: 'Failed to send test email', detail: err.message };
    }
  });

  // ── POST /v1/admin/alerts/daily-summary — trigger the daily summary on demand
  fastify.post('/v1/admin/alerts/daily-summary', async (request, reply) => {
    if (!config.ownerEmail) {
      reply.status(422);
      return { error: 'OWNER_EMAIL not configured' };
    }
    // Fire-and-forget so the HTTP response returns immediately
    triggerDailySummary().catch(() => {});
    writeAuditLog({ actorEmail: request.user.email, action: 'daily_summary_triggered' });
    return { triggered: true };
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function scanKeys(redis, pattern) {
  const stream = redis.scanStream({ match: pattern, count: 100 });
  const keys = [];
  await new Promise((resolve, reject) => {
    stream.on('data', k => keys.push(...k));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return keys;
}

async function triggerDailySummary() {
  const db = await getDb();
  const redis = getRedis();
  // FIX-3: true IST calendar-day window for "yesterday" — no rolling 24h.
  const { startUtc, endUtc } = getYesterdayBoundsIST();

  const [stats] = await db.collection('requests').aggregate([
    { $match: { created_at: { $gte: startUtc, $lt: endUtc } } },
    {
      $group: {
        _id:             null,
        totalRequests:   { $sum: 1 },
        successRequests: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
        errorRequests:   { $sum: { $cond: [{ $ne:  ['$status', 'success'] }, 1, 0] } },
        avgLatencyMs:    { $avg: '$latency_ms' },
        maxLatencyMs:    { $max: '$latency_ms' },
      },
    },
  ]).toArray();

  const topModelDoc = await db.collection('requests').aggregate([
    { $match: { created_at: { $gte: startUtc, $lt: endUtc }, status: 'success' } },
    { $group: { _id: '$model', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 1 },
  ]).next();

  const [activeKeys, totalUsers] = await Promise.all([
    redis.llen('gemini_keys'),
    db.collection('users').countDocuments(),
  ]);

  notifyAdminDailySummary({
    date:            new Date().toISOString().slice(0, 10),
    totalRequests:   stats?.totalRequests   ?? 0,
    successRequests: stats?.successRequests ?? 0,
    errorRequests:   stats?.errorRequests   ?? 0,
    avgLatencyMs:    Math.round(stats?.avgLatencyMs ?? 0),
    maxLatencyMs:    stats?.maxLatencyMs    ?? 0,
    activeKeys,
    totalUsers,
    topModel:        topModelDoc?._id ?? null,
  });
}
