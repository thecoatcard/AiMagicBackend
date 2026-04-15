import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getKey, returnKey, cooldownKey } from '../redis/keyPool.js';
import { recordSuccess, recordFailure, getBestModel } from '../redis/modelHealth.js';
import { getFallbackModels } from '../redis/modelConfig.js';
import { streamGenerateContent } from '../services/gemini.js';
import { logRequest, logError } from '../db/logger.js';
import { checkUserRateLimit } from '../middleware/rateLimiter.js';
import { notifyAdminNoKeys } from '../services/notifications.js';
import { imagesSchema, historySchema } from './generate.js';

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

    const requestId    = randomUUID();
    const userEmail    = request.user?.email;
    const promptLength = prompt?.length ?? 0;
    const wallStart    = Date.now();

    // ── Model selection — mirrors orchestrator.js logic ──────────────────────
    const fallbackModels = await getFallbackModels();
    let currentModel  = model ?? await getBestModel(fallbackModels);
    let fallbackIndex = fallbackModels.indexOf(currentModel); // -1 = custom model

    // Shared retry tracking (for logRequest parity with /v1/generate)
    let retries       = 0;
    let lastKeyMasked = null;
    // ─────────────────────────────────────────────────────────────────────────

    for (let attempt = 0; attempt < config.maxRetries; attempt++) {
      if (attempt > 0) retries++;

      const key = await getKey();
      if (!key) {
        logRequest({ request_id: requestId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'error', retries, prompt_length: promptLength, user_email: userEmail });
        notifyAdminNoKeys();
        reply.status(503);
        return { error: 'No API keys available', code: 'NO_KEYS', request_id: requestId };
      }
      lastKeyMasked = maskKey(key);

      let result;
      try {
        result = await streamGenerateContent(key, currentModel, prompt ?? '', options);
      } catch (err) {
        await returnKey(key);

        if (err.code === 'TIMEOUT') {
          await recordFailure(currentModel, 'timeout');
          logError({ type: 'timeout', model: currentModel, key_masked: lastKeyMasked, message: err.message, user_email: userEmail });

          // Fall back to next lighter model — same logic as orchestrator.js
          if (fallbackIndex === -1) {
            fallbackIndex = 0;
            currentModel  = fallbackModels[0] ?? null;
          } else {
            fallbackIndex++;
            currentModel = fallbackModels[fallbackIndex] ?? null;
          }
          if (!currentModel) break;
          continue;
        }

        logError({ type: 'other', model: currentModel, key_masked: lastKeyMasked, message: err.message });
        logRequest({ request_id: requestId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'error', retries, prompt_length: promptLength, user_email: userEmail });
        reply.status(502);
        return { error: err.message, code: 'UPSTREAM_ERROR', request_id: requestId };
      }

      if (result.status === 429) {
        result.bodyStream.destroy();
        logError({ type: '429', model: currentModel, key_masked: lastKeyMasked });
        await cooldownKey(key, config.cooldownMs);
        continue; // same model, rotate key
      }

      if (result.status === 503) {
        result.bodyStream.destroy();
        await returnKey(key);
        await recordFailure(currentModel, '503');
        logError({ type: '503', model: currentModel, key_masked: lastKeyMasked });

        const remaining = fallbackIndex === -1
          ? fallbackModels
          : fallbackModels.slice(fallbackIndex + 1);
        if (remaining.length === 0) break;
        currentModel  = await getBestModel(remaining);
        if (!currentModel) break;
        fallbackIndex = fallbackModels.indexOf(currentModel);
        continue;
      }

      if (result.status !== 200) {
        result.bodyStream.destroy();
        await returnKey(key);
        await recordFailure(currentModel, 'other');
        logError({ type: String(result.status), model: currentModel, key_masked: lastKeyMasked });
        logRequest({ request_id: requestId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'error', retries, prompt_length: promptLength, user_email: userEmail });
        reply.status(result.status >= 400 && result.status < 600 ? result.status : 502);
        return { error: 'Gemini API error', code: String(result.status), request_id: requestId };
      }

      // ── Success — stream back to client ────────────────────────────────────
      await returnKey(key);
      await recordSuccess(currentModel, Date.now() - wallStart);
      reply.hijack();

      const res = reply.raw;

      // Disable Nagle's algorithm — prevents OS from batching small SSE chunks
      // into larger TCP packets, causing multi-second delivery delays.
      res.socket?.setNoDelay?.(true);

      // CORS — @fastify/cors onSend hook is skipped after hijack(), set manually.
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
        'X-Model-Used':                     currentModel,
        'Access-Control-Allow-Origin':      corsOrigin,
        'Access-Control-Allow-Credentials': 'true',
      });

      // Flush headers to client immediately — headers are lazy in Node.js HTTP.
      res.write(': ok\n\n');

      let streamStatus = 'success';
      try {
        for await (const chunk of result.bodyStream) {
          if (res.writableEnded) break;
          if (!chunk || chunk.length === 0) continue;

          // write() returns false when kernel send-buffer is full (backpressure).
          const ok = res.write(chunk);
          if (!ok) await new Promise(resolve => res.once('drain', resolve));
        }
      } catch (streamErr) {
        streamStatus = 'error';
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: 'Stream interrupted', code: 'STREAM_ERROR' })}\n\n`);
        }
      } finally {
        if (!res.writableEnded) res.end();
        // Log to MongoDB so /v1/usage and /v1/logs include stream requests —
        // without this, stream requests are invisible to analytics even though
        // they count against quota (incrementUserUsage fires in the preHandler).
        logRequest({
          request_id:     requestId,
          model:          currentModel,
          api_key_masked: lastKeyMasked,
          latency_ms:     Date.now() - wallStart,
          status:         streamStatus,
          retries,
          prompt_length:  promptLength,
          user_email:     userEmail,
        });
      }
      return;
    }

    // All retries exhausted
    logRequest({ request_id: requestId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'exhausted', retries, prompt_length: promptLength, user_email: userEmail });
    reply.status(503);
    return { error: 'All retries exhausted', code: 'RETRIES_EXHAUSTED', request_id: requestId };
  });
}
