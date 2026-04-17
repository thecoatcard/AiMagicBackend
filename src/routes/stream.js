import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getKey, returnKey, cooldownKey, disableKey } from '../redis/keyPool.js';
import { recordSuccess, recordFailure, getBestModel } from '../redis/modelHealth.js';
import { getFallbackModels } from '../redis/modelConfig.js';
import { runStream } from '../services/orchestrator.js';
import { logRequest, logError } from '../db/logger.js';
import { checkUserRateLimit } from '../middleware/rateLimiter.js';
import { notifyAdminNoKeys } from '../services/notifications.js';
import { imagesSchema, historySchema } from './generate.js';
import {
  requestsTotal,
  requestDuration,
  retriesTotal,
  keyCooldownsTotal,
  model503Total,
  modelTimeoutsTotal,
} from '../metrics/index.js';

function maskKey(key) {
  if (!key || key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

export async function streamRoutes(fastify) {
  fastify.post('/v1/generate/stream', {
    preHandler: checkUserRateLimit,
    schema: {
      body: {
        type: 'object',
        properties: {
          prompt:            { type: 'string', minLength: 1 },
          images:            imagesSchema,
          model:             { type: 'string' },
          temperature:       { type: 'number', minimum: 0, maximum: 2 },
          maxOutputTokens:   { type: 'integer', minimum: 1 },
          systemInstruction: { type: 'string', minLength: 1, maxLength: 8192 },
          history:           historySchema,
          thinkingBudget:    { type: 'integer', minimum: 0, maximum: 24576 },
        },
      },
    },
  }, async (request, reply) => {
    const { prompt, images, model, temperature, maxOutputTokens,
            systemInstruction, history, thinkingBudget } = request.body;

    if (!prompt && (!images || images.length === 0)) {
      reply.status(400);
      return { error: 'Either prompt or images (or both) must be provided', code: 'BAD_REQUEST' };
    }

    if (images) {
      for (const img of images) {
        const t = img.type ?? 'base64';
        if (t === 'base64' && !img.data) {
          reply.status(400);
          return { error: 'Images of type "base64" must include a "data" field', code: 'BAD_REQUEST' };
        }
        if (t === 'url' && !img.url?.startsWith('https://')) {
          reply.status(400);
          return { error: 'Image URLs must use HTTPS', code: 'BAD_REQUEST' };
        }
      }
    }

    const options = {};
    if (temperature        !== undefined) options.temperature        = temperature;
    if (maxOutputTokens    !== undefined) options.maxOutputTokens    = maxOutputTokens;
    if (images?.length)                   options.images             = images;
    if (systemInstruction)                options.systemInstruction  = systemInstruction;
    if (history?.length)                  options.history            = history;
    if (thinkingBudget     !== undefined) options.thinkingBudget     = thinkingBudget;

    const requestId = randomUUID();
    const userEmail = request.user?.email;
    const promptLength = prompt?.length ?? 0;

    const result = await runStream({ 
      prompt: prompt ?? '', 
      model, 
      options, 
      requestId, 
      userEmail 
    });

    if (result.error) {
      reply.status(result.httpStatus || 500);
      return result;
    }

    // Success — stream back to client
    const { bodyStream, model: usedModel, key, lastKeyMasked, retries, wallStart } = result;

    reply.hijack();
    const res = reply.raw;

    // Disable Nagle's algorithm
    res.socket?.setNoDelay?.(true);

    const requestOrigin = request.headers.origin;
    const allowedOrigins = (process.env.CORS_ORIGINS || '')
      .split(',').map(o => o.trim()).filter(Boolean);
    const corsOrigin = allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : (allowedOrigins[0] ?? '*');

    res.writeHead(200, {
      'Content-Type':                     'text/event-stream',
      'Cache-Control':                    'no-cache, no-transform',
      'Connection':                       'keep-alive',
      'X-Accel-Buffering':               'no',
      'X-Request-Id':                     requestId,
      'X-Model-Used':                     usedModel,
      'Access-Control-Allow-Origin':      corsOrigin,
      'Access-Control-Allow-Credentials': 'true',
    });

    res.write(': ok\n\n');

    let streamStatus = 'success';
    try {
      for await (const chunk of bodyStream) {
        if (res.writableEnded) break;
        if (!chunk || chunk.length === 0) continue;
        const ok = res.write(chunk);
        if (!ok) await new Promise(resolve => res.once('drain', resolve));
      }
    } catch (streamErr) {
      streamStatus = 'error';
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: 'Stream interrupted', code: 'STREAM_ERROR' })}\n\n`);
      }
    } finally {
      // 1. Drip key back to pool
      await returnKey(key);
      
      // 2. Wrap up response
      if (!res.writableEnded) res.end();

      // 3. Health & Analytics
      const latencyMs = Date.now() - wallStart;
      if (streamStatus === 'success') {
        await recordSuccess(usedModel, latencyMs);
      } else {
        await recordFailure(usedModel, 'other');
      }

      logRequest({
        request_id:     requestId,
        model:          usedModel,
        api_key_masked: lastKeyMasked,
        latency_ms:     latencyMs,
        status:         streamStatus,
        retries,
        prompt_length:  promptLength,
        user_email:     userEmail,
      });
    }
  });
}
