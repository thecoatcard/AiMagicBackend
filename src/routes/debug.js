import { generateContent } from '../services/gemini.js';
import { getKey, returnKey, cooldownKey } from '../redis/keyPool.js';
import { config } from '../config.js';

export async function debugRoutes(fastify) {
  fastify.post('/v1/debug/test-key', {
    schema: {
      body: {
        type: 'object',
        required: ['key'],
        properties: {
          key:   { type: 'string', minLength: 1 },
          model: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { key, model = config.defaultModel } = request.body;
    const start = Date.now();

    let status, error, latencyMs;
    try {
      const result = await generateContent(key, model, 'Say "ok"', { maxOutputTokens: 5 });
      status = result.status;
      latencyMs = Date.now() - start;
      if (result.status === 200) {
        return { ok: true, status, latency_ms: latencyMs, model };
      }
      error = result.data?.error?.message || `HTTP ${result.status}`;
    } catch (err) {
      status = err.code === 'TIMEOUT' ? 'timeout' : 'error';
      error = err.message;
      latencyMs = Date.now() - start;
    }

    return { ok: false, status, error, latency_ms: latencyMs, model };
  });

  fastify.post('/v1/debug/test-model', {
    schema: {
      body: {
        type: 'object',
        required: ['model'],
        properties: {
          model: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { model } = request.body;
    const key = await getKey();

    if (!key) {
      reply.status(503);
      return { ok: false, error: 'No keys available' };
    }

    const start = Date.now();
    try {
      const result = await generateContent(key, model, 'Say "ok"', { maxOutputTokens: 5 });
      const latencyMs = Date.now() - start;

      if (result.status === 200) {
        await returnKey(key);
        return { ok: true, status: 200, latency_ms: latencyMs, model };
      }

      if (result.status === 429) {
        // Do NOT returnKey first — go straight to cooldown
        await cooldownKey(key, config.cooldownMs);
        return { ok: false, status: 429, error: 'Key rate limited', latency_ms: latencyMs, model };
      }

      await returnKey(key);
      const error = result.data?.error?.message || `HTTP ${result.status}`;
      return { ok: false, status: result.status, error, latency_ms: latencyMs, model };
    } catch (err) {
      await returnKey(key);
      const latencyMs = Date.now() - start;
      const status = err.code === 'TIMEOUT' ? 'timeout' : 'error';
      return { ok: false, status, error: err.message, latency_ms: latencyMs, model };
    }
  });
}
