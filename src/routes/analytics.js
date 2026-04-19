import { getDb } from '../db/client.js';
import { getUser } from '../db/users.js';
import { requireAdmin, requireOwner } from '../auth/roles.js';
import { getDailyUsage } from '../middleware/rateLimiter.js';
import { PLANS } from '../config/plans.js';
import { getPlanDailyLimit } from '../redis/systemConfig.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export async function analyticsRoutes(fastify) {
  // GET /v1/logs — paginated request log
  // Users see only their own requests; admins see all.
  fastify.get('/v1/logs', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
          skip:   { type: 'integer', minimum: 0, default: 0 },
          model:  { type: 'string' },
          status: { type: 'string', enum: ['success', 'error', 'exhausted'] },
        },
      },
    },
  }, async (request, reply) => {
    const { limit, skip, model, status } = request.query;
    const filter = {};
    if (model)  filter.model  = model;
    if (status) filter.status = status;
    // Non-owners can only see their own requests (Admins are now restricted from global logs)
    const isPrivileged = request.user.role === 'owner';
    if (!isPrivileged) filter.user_email = request.user.email;

    let db;
    try { db = await getDb(); } catch {
      reply.status(503); return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }
    const [docs, total] = await Promise.all([
      db.collection('requests')
        .find(filter, { projection: { _id: 0 } })
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      db.collection('requests').countDocuments(filter),
    ]);

    return { total, limit, skip, logs: docs };
  });

  // GET /v1/errors — paginated error log (admin only)
  fastify.get('/v1/errors', {
    preHandler: requireOwner,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
          skip:  { type: 'integer', minimum: 0, default: 0 },
          type:  { type: 'string' },
          model: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { limit, skip, type, model } = request.query;
    const filter = {};
    if (type)  filter.type  = type;
    if (model) filter.model = model;

    let db;
    try { db = await getDb(); } catch {
      reply.status(503); return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }
    const [docs, total] = await Promise.all([
      db.collection('errors')
        .find(filter, { projection: { _id: 0 } })
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      db.collection('errors').countDocuments(filter),
    ]);

    return { total, limit, skip, errors: docs };
  });

  // GET /v1/usage — aggregated stats
  // Users see only their own aggregation; admins see global stats.
  fastify.get('/v1/usage', async (request, reply) => {
    let db;
    try { db = await getDb(); } catch {
      reply.status(503); return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }

    const isOwner = request.user.role === 'owner';
    const matchStage = isOwner ? {} : { user_email: request.user.email };
    const matchFilter = Object.keys(matchStage).length > 0 ? [{ $match: matchStage }] : [];

    const [overall, byModel, byStatus] = await Promise.all([
      // Overall totals
      db.collection('requests').aggregate([
        ...matchFilter,
        {
          $group: {
            _id: null,
            total_requests: { $sum: 1 },
            total_retries:  { $sum: '$retries' },
            avg_latency_ms: { $avg: '$latency_ms' },
            max_latency_ms: { $max: '$latency_ms' },
          },
        },
      ]).toArray(),

      // Breakdown by model
      db.collection('requests').aggregate([
        ...matchFilter,
        {
          $group: {
            _id: '$model',
            requests:       { $sum: 1 },
            success:        { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
            avg_latency_ms: { $avg: '$latency_ms' },
          },
        },
        { $sort: { requests: -1 } },
      ]).toArray(),

      // Breakdown by status
      db.collection('requests').aggregate([
        ...matchFilter,
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).toArray(),
    ]);

    return {
      overall: overall[0]
        ? {
            total_requests: overall[0].total_requests,
            total_retries:  overall[0].total_retries,
            avg_latency_ms: Math.round(overall[0].avg_latency_ms || 0),
            max_latency_ms: Math.round(overall[0].max_latency_ms || 0),
          }
        : null,
      by_model:  byModel.map(m => ({ model: m._id, requests: m.requests, success: m.success, avg_latency_ms: Math.round(m.avg_latency_ms || 0) })),
      by_status: Object.fromEntries(byStatus.map(s => [s._id, s.count])),
    };
  });

  // GET /v1/analytics/time-series — request counts bucketed by hour or day (admin only)
  fastify.get('/v1/analytics/time-series', {
    preHandler: requireOwner,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          interval: { type: 'string', enum: ['hour', 'day'], default: 'day' },
          days:     { type: 'integer', minimum: 1, maximum: 90, default: 7 },
        },
      },
    },
  }, async (request, reply) => {
    let db;
    try { db = await getDb(); } catch {
      reply.status(503); return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }

    const { interval, days } = request.query;
    const since = new Date(Date.now() - days * 86400 * 1000);

    const groupId = interval === 'hour'
      ? { year: { $year: '$created_at' }, month: { $month: '$created_at' }, day: { $dayOfMonth: '$created_at' }, hour: { $hour: '$created_at' } }
      : { year: { $year: '$created_at' }, month: { $month: '$created_at' }, day: { $dayOfMonth: '$created_at' } };

    const buckets = await db.collection('requests').aggregate([
      { $match: { created_at: { $gte: since } } },
      {
        $group: {
          _id:      groupId,
          total:    { $sum: 1 },
          success:  { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
          errors:   { $sum: { $cond: [{ $ne:  ['$status', 'success'] }, 1, 0] } },
          avg_latency_ms: { $avg: '$latency_ms' },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 } },
    ]).toArray();

    return { interval, days, buckets };
  });

  // GET /v1/analytics/users — per-user usage stats (admin only)
  fastify.get('/v1/analytics/users', {
    preHandler: requireOwner,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          days:  { type: 'integer', minimum: 1, maximum: 90,  default: 7  },
        },
      },
    },
  }, async (request, reply) => {
    let db;
    try { db = await getDb(); } catch {
      reply.status(503); return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }

    const { limit, days } = request.query;
    const since = new Date(Date.now() - days * 86400 * 1000);

    const results = await db.collection('requests').aggregate([
      { $match: { created_at: { $gte: since } } },
      {
        $group: {
          _id:            '$user_email',
          total_requests: { $sum: 1 },
          success_count:  { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
          error_count:    { $sum: { $cond: [{ $ne:  ['$status', 'success'] }, 1, 0] } },
          avg_latency_ms: { $avg: '$latency_ms' },
          last_request:   { $max: '$created_at' },
        },
      },
      { $sort: { total_requests: -1 } },
      { $limit: limit },
    ]).toArray();

    return { days, users: results.map(r => ({ email: r._id, ...r, _id: undefined })) };
  });

  // GET /v1/analytics/errors/summary — error type breakdown (admin only)
  fastify.get('/v1/analytics/errors/summary', {
    preHandler: requireOwner,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 90, default: 7 },
        },
      },
    },
  }, async (request, reply) => {
    let db;
    try { db = await getDb(); } catch {
      reply.status(503); return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }

    const since = new Date(Date.now() - request.query.days * 86400 * 1000);

    const [byType, byModel, recent] = await Promise.all([
      db.collection('errors').aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray(),
      db.collection('errors').aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $group: { _id: '$model', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray(),
      db.collection('errors')
        .find({ timestamp: { $gte: since } }, { projection: { _id: 0 } })
        .sort({ timestamp: -1 }).limit(10).toArray(),
    ]);

    return {
      days:      request.query.days,
      by_type:   Object.fromEntries(byType.map(r  => [r._id, r.count])),
      by_model:  Object.fromEntries(byModel.map(r => [r._id, r.count])),
      recent,
    };
  });

  // DELETE /v1/logs — purge request logs older than N days (admin only)
  fastify.delete('/v1/logs', {
    preHandler: requireOwner,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          older_than_days: { type: 'integer', minimum: 1, default: 30 },
        },
      },
    },
  }, async (request, reply) => {
    let db;
    try { db = await getDb(); } catch {
      reply.status(503); return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }

    const cutoff = new Date(Date.now() - request.query.older_than_days * 86400 * 1000);
    const result = await db.collection('requests').deleteMany({ created_at: { $lt: cutoff } });
    return { deleted: result.deletedCount, cutoff };
  });

  // GET /v1/logs/export — CSV export of request logs (admin only)
  fastify.get('/v1/logs/export', {
    preHandler: requireOwner,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          days:  { type: 'integer', minimum: 1, maximum: 90, default: 7 },
          limit: { type: 'integer', minimum: 1, maximum: 10000, default: 5000 },
        },
      },
    },
  }, async (request, reply) => {
    let db;
    try { db = await getDb(); } catch {
      reply.status(503); return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }

    const since = new Date(Date.now() - request.query.days * 86400 * 1000);
    const docs = await db.collection('requests')
      .find({ created_at: { $gte: since } }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(request.query.limit)
      .toArray();

    const headers = ['request_id', 'user_email', 'model', 'status', 'latency_ms', 'retries', 'created_at'];
    const rows = docs.map(d =>
      headers.map(h => {
        const v = d[h] ?? '';
        return String(v).includes(',') ? `"${v}"` : v;
      }).join(',')
    );

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="requests-${request.query.days}d.csv"`);
    return [headers.join(','), ...rows].join('\n');
  });

  // GET /v1/quota — real-time daily quota status for the current user.
  // Admins and owners have no daily limit.
  fastify.get('/v1/quota', async (request) => {
    const { email, role } = request.user;

    if (role === 'admin' || role === 'owner') {
      return {
        plan:             role,
        used_today:       0,
        limit:            null,
        remaining:        null,
        reset_in_seconds: null,
      };
    }

    // Fetch user plan + custom limit override from DB
    const user = await getUser(email);
    const plan  = user?.plan ?? 'free';
    const limit = user?.limits?.max_requests_per_day ?? await getPlanDailyLimit(plan);

    const { used, reset_in_seconds } = await getDailyUsage(email);
    const remaining = Math.max(0, limit - used);

    return {
      plan,
      used_today:       used,
      limit,
      remaining,
      reset_in_seconds,
      plan_details:     PLANS[plan] ?? null,
    };
  });
}
