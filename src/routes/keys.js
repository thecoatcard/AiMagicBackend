import { listKeys, addKey, enableKey, disableKey, clearAllCooldowns, getPoolStats, removeKey, resolveRawKey, classifyKeyFailure } from '../redis/keyPool.js';
import { generateContent } from '../services/gemini.js';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { notifyAdminKeyDisabled } from '../services/notifications.js';
import { writeAuditLog } from '../db/auditLog.js';
import { maskKey } from '../services/orchestrator.js';

export async function keysRoutes(fastify) {
  fastify.post('/v1/keys/bulk-delete', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['keys'],
        properties: {
          keys: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', pattern: '^.{4}…[a-f0-9]{6}….{4}$' } },
        },
      },
    },
  }, async (request) => {
    const results = [];
    for (let offset = 0; offset < request.body.keys.length; offset += 10) {
      const batch = await Promise.all(request.body.keys.slice(offset, offset + 10).map(async key => {
        try {
          return { key, ...await removeKey(key) };
        } catch {
          return { key, removed: false, error: 'Deletion failed; retry this key' };
        }
      }));
      results.push(...batch);
    }
    writeAuditLog({ actorEmail: request.user.email, action: 'bulk_key_delete', meta: { count: results.filter(result => result.removed).length } });
    return { results };
  });

  fastify.post('/v1/keys/:key/test', {
    schema: {
      params: { type: 'object', required: ['key'], properties: { key: { type: 'string', pattern: '^.{4}…[a-f0-9]{6}….{4}$' } } },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { model: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9._-]+$' } },
      },
    },
  }, async (request, reply) => {
    const key = await resolveRawKey(request.params.key);
    if (!key) return reply.code(404).send({ error: 'Key not found' });
    const model = request.body?.model ?? config.defaultModel;
    const start = Date.now();
    try {
      const result = await generateContent(key, model, 'Say "ok"', { maxOutputTokens: 5 });
      const reason = classifyKeyFailure(result);
      if (reason) await disableKey(key, reason);
      writeAuditLog({ actorEmail: request.user.email, action: 'key_test', meta: { key: request.params.key, model, status: result.status } });
      return {
        ok: result.status === 200,
        status: result.status,
        reason,
        model,
        latency_ms: Date.now() - start,
        error: result.status === 200 ? null : reason ?? `Provider returned HTTP ${result.status}`,
      };
    } catch {
      return { ok: false, status: 'error', model, latency_ms: Date.now() - start, error: 'Provider test failed or timed out' };
    }
  });

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
    await disableKey(key, 'admin');
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
      await disableKey(key, 'admin');
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
