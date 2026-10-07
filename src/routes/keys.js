import { listKeys, addKey, enableKey, disableKey, clearAllCooldowns, getPoolStats, removeKey, resolveRawKey, classifyKeyFailure, categorizeTestResult } from '../redis/keyPool.js';
import { generateContent } from '../services/gemini.js';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { recordKeyTest } from '../db/apiKeys.js';
import { notifyAdminKeyDisabled } from '../services/notifications.js';
import { writeAuditLog } from '../db/auditLog.js';
import { maskKey } from '../services/orchestrator.js';

const MASKED_KEY_PATTERN = '^.{4}…[a-f0-9]{6}….{4}$';
const maskedKeysSchema = { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', pattern: MASKED_KEY_PATTERN } };
const modelSchema = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9._-]+$' };
const TEST_CONCURRENCY = 8;

const displayKey = key => (key.includes('…') ? key : maskKey(key));

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

async function testCredential(maskedKey, model) {
  const key = await resolveRawKey(maskedKey);
  if (!key) return { key: maskedKey, ok: false, status: 404, category: 'not_found', model, latency_ms: 0, error: 'Key not found' };
  const start = Date.now();
  let outcome;
  try {
    const result = await generateContent(key, model, 'Say "ok"', { maxOutputTokens: 5 });
    const reason = classifyKeyFailure(result);
    if (reason) await disableKey(key, reason);
    outcome = {
      ok: result.status === 200,
      status: result.status,
      reason,
      category: categorizeTestResult(result.status, reason),
      latency_ms: Date.now() - start,
      error: result.status === 200 ? null : reason ?? `Provider returned HTTP ${result.status}`,
    };
  } catch {
    outcome = { ok: false, status: 'error', reason: null, category: 'inconclusive', latency_ms: Date.now() - start, error: 'Provider test failed or timed out' };
  }
  await recordKeyTest(key, { ok: outcome.ok, status: outcome.status, reason: outcome.reason, model, latencyMs: outcome.latency_ms }).catch(() => {});
  return { key: maskedKey, model, ...outcome };
}

export async function keysRoutes(fastify) {
  fastify.post('/v1/keys/bulk-delete', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['keys'],
        properties: { keys: maskedKeysSchema },
      },
    },
  }, async (request) => {
    const results = await mapLimit(request.body.keys, 10, async key => {
      try {
        return { key, ...await removeKey(key) };
      } catch {
        return { key, removed: false, error: 'Deletion failed; retry this key' };
      }
    });
    writeAuditLog({ actorEmail: request.user.email, action: 'bulk_key_delete', meta: { count: results.filter(result => result.removed).length } });
    return { results };
  });

  fastify.post('/v1/keys/bulk-test', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['keys'],
        properties: { keys: maskedKeysSchema, model: modelSchema },
      },
    },
  }, async (request) => {
    const model = request.body.model ?? config.defaultModel;
    const results = await mapLimit(request.body.keys, TEST_CONCURRENCY, key => testCredential(key, model));
    const summary = results.reduce((acc, result) => ({ ...acc, [result.category]: (acc[result.category] ?? 0) + 1 }), {});
    writeAuditLog({ actorEmail: request.user.email, action: 'bulk_key_test', meta: { count: results.length, model, summary } });
    return { model, summary, results };
  });

  fastify.post('/v1/keys/:key/test', {
    schema: {
      params: { type: 'object', required: ['key'], properties: { key: { type: 'string', pattern: MASKED_KEY_PATTERN } } },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { model: modelSchema },
      },
    },
  }, async (request, reply) => {
    const model = request.body?.model ?? config.defaultModel;
    const result = await testCredential(request.params.key, model);
    if (result.category === 'not_found') return reply.code(404).send({ error: 'Key not found' });
    writeAuditLog({ actorEmail: request.user.email, action: 'key_test', meta: { key: request.params.key, model, status: result.status } });
    const { key, ...body } = result;
    return body;
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
    writeAuditLog({ actorEmail: request.user.email, action: 'key_enable', meta: { key: displayKey(key) } });
    reply.status(200);
    return { status: 'enabled', key: displayKey(key) };
  });

  // Disable a key (move from active → permanent disabled)
  fastify.patch('/v1/keys/:key/disable', async (request, reply) => {
    const key = decodeURIComponent(request.params.key);
    await disableKey(key, 'admin');
    notifyAdminKeyDisabled({ maskedKey: displayKey(key) });
    writeAuditLog({ actorEmail: request.user.email, action: 'key_disable', meta: { key: displayKey(key) } });
    reply.status(200);
    return { status: 'disabled', key: displayKey(key) };
  });

  // Bulk enable keys; compromised keys are skipped rather than failing the batch
  fastify.post('/v1/keys/bulk-enable', {
    schema: {
      body: {
        type: 'object',
        required: ['keys'],
        properties: {
          keys: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 100 },
        },
      },
    },
  }, async (request) => {
    const results = await mapLimit(request.body.keys, 10, async key => {
      try {
        await enableKey(key);
        return { key: displayKey(key), status: 'enabled' };
      } catch (err) {
        return { key: displayKey(key), status: 'skipped', error: err.code === 'KEY_QUARANTINED' ? 'quarantined' : 'failed' };
      }
    });
    writeAuditLog({ actorEmail: request.user.email, action: 'bulk_key_enable', meta: { count: results.filter(r => r.status === 'enabled').length } });
    return { results };
  });

  // Bulk disable keys
  fastify.post('/v1/keys/bulk-disable', {
    schema: {
      body: {
        type: 'object',
        required: ['keys'],
        properties: {
          keys: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 100 },
        },
      },
    },
  }, async (request) => {
    const results = await mapLimit(request.body.keys, 10, async key => {
      try {
        await disableKey(key, 'admin');
        return { key: displayKey(key), status: 'disabled' };
      } catch {
        return { key: displayKey(key), status: 'skipped', error: 'failed' };
      }
    });
    const disabled = results.filter(r => r.status === 'disabled');
    if (disabled.length === 1) notifyAdminKeyDisabled({ maskedKey: disabled[0].key });
    else if (disabled.length > 1) notifyAdminKeyDisabled({ maskedKey: `${disabled.length} keys (bulk)` });
    writeAuditLog({ actorEmail: request.user.email, action: 'bulk_key_disable', meta: { count: disabled.length } });
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
