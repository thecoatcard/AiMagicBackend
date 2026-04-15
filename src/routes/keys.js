import { listKeys, addKey, enableKey, disableKey, clearAllCooldowns, getPoolStats } from '../redis/keyPool.js';
import { getDb } from '../db/client.js';
import { notifyAdminKeyDisabled } from '../services/notifications.js';
import { writeAuditLog } from '../db/auditLog.js';

export async function keysRoutes(fastify) {
  // List all keys (masked)
  fastify.get('/v1/keys', async () => {
    return listKeys();
  });

  // Add one or more keys
  fastify.post('/v1/keys', {
    schema: {
      body: {
        type: 'object',
        required: ['keys'],
        properties: {
          keys: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            minItems: 1,
          },
        },
      },
    },
  }, async (request) => {
    const results = [];
    for (const key of request.body.keys) {
      const result = await addKey(key);
      results.push({ key: maskKey(key), ...result });
    }
    return { results };
  });

  // Enable a key (move from cooldown/disabled → active)
  fastify.patch('/v1/keys/:key/enable', async (request, reply) => {
    const key = decodeURIComponent(request.params.key);
    await enableKey(key);
    writeAuditLog({ actorEmail: request.user.email, action: 'key_enable', meta: { key: maskKey(key) } });
    reply.status(200);
    return { status: 'enabled', key: maskKey(key) };
  });

  // Disable a key (move from active → permanent disabled)
  fastify.patch('/v1/keys/:key/disable', async (request, reply) => {
    const key = decodeURIComponent(request.params.key);
    await disableKey(key);
    notifyAdminKeyDisabled({ maskedKey: maskKey(key) });
    writeAuditLog({ actorEmail: request.user.email, action: 'key_disable', meta: { key: maskKey(key) } });
    reply.status(200);
    return { status: 'disabled', key: maskKey(key) };
  });

  // Bulk enable keys
  fastify.post('/v1/keys/bulk-enable', {
    schema: {
      body: {
        type: 'object',
        required: ['keys'],
        properties: {
          keys: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
    },
  }, async (request) => {
    const results = [];
    for (const key of request.body.keys) {
      await enableKey(key);
      results.push({ key: maskKey(key), status: 'enabled' });
    }
    writeAuditLog({ actorEmail: request.user.email, action: 'bulk_key_enable', meta: { count: results.length } });
    return { results };
  });

  // Bulk disable keys
  fastify.post('/v1/keys/bulk-disable', {
    schema: {
      body: {
        type: 'object',
        required: ['keys'],
        properties: {
          keys: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
    },
  }, async (request) => {
    const results = [];
    for (const key of request.body.keys) {
      await disableKey(key);
      notifyAdminKeyDisabled({ maskedKey: maskKey(key) });
      results.push({ key: maskKey(key), status: 'disabled' });
    }
    writeAuditLog({ actorEmail: request.user.email, action: 'bulk_key_disable', meta: { count: results.length } });
    return { results };
  });

  // Clear all temporary cooldowns (restore to active pool)
  fastify.post('/v1/keys/clear-cooldowns', async (request) => {
    const restored = await clearAllCooldowns();
    writeAuditLog({ actorEmail: request.user.email, action: 'clear_cooldowns', meta: { restored } });
    return { restored };
  });

  // Key pool statistics
  fastify.get('/v1/keys/pool-stats', async () => {
    return getPoolStats();
  });

  // Per-key usage stats from MongoDB
  fastify.get('/v1/keys/:key/stats', async (request, reply) => {
    const keyMasked = decodeURIComponent(request.params.key);
    let db;
    try {
      db = await getDb();
    } catch (err) {
      reply.status(503);
      return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }

    const [stats] = await db.collection('requests').aggregate([
      { $match: { api_key_masked: keyMasked } },
      {
        $group: {
          _id: null,
          total_requests: { $sum: 1 },
          success_count:  { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
          failure_count:  { $sum: { $cond: [{ $ne:  ['$status', 'success'] }, 1, 0] } },
          avg_latency_ms: { $avg: '$latency_ms' },
          last_used:      { $max: '$created_at' },
        },
      },
    ]).toArray();

    if (!stats) {
      reply.status(404);
      return { error: 'No data found for this key' };
    }

    return {
      key: keyMasked,
      total_requests: stats.total_requests,
      success_count:  stats.success_count,
      failure_count:  stats.failure_count,
      avg_latency_ms: Math.round(stats.avg_latency_ms || 0),
      last_used:      stats.last_used,
    };
  });
}

function maskKey(key) {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}
