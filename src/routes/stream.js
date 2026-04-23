import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getKey, returnKey, cooldownKey, disableKey, recordKeySuccess, recordKeyFailure, isPoolExhausted } from '../redis/keyPool.js';
import { recordSuccess, recordFailure, getBestModel } from '../redis/modelHealth.js';
import { getFallbackModels } from '../redis/modelConfig.js';
import { streamGenerateContent } from '../services/gemini.js';
import { logRequest, logError } from '../db/logger.js';
import { checkUserRateLimit } from '../middleware/rateLimiter.js';
import { notifyAdminNoKeys } from '../services/notifications.js';
import { imagesSchema, historySchema, filesSchema } from './generate.js';
import { parseFileToContent } from '../services/fileParsers.js';
import { maskKey } from '../services/orchestrator.js';
import { recordFailureRateTick, isHivemindRuntimeEnabled } from '../redis/systemConfig.js';
import { isHivemindEnabled, retrieveContext, storeContext, buildContextPrefix } from '../services/hivemind.js';
import { runEmbed } from '../services/orchestrator.js';
import { config as appConfig } from '../config.js';
import {
  requestsTotal,
  requestDuration,
  retriesTotal,
  keyCooldownsTotal,
  model503Total,
  modelTimeoutsTotal,
} from '../metrics/index.js';

export async function streamRoutes(fastify) {
  fastify.post('/v1/generate/stream', {
    preHandler: checkUserRateLimit,
    schema: {
      body: {
        type: 'object',
        properties: {
          prompt: { type: 'string', minLength: 1 },
          images: imagesSchema,
          files: filesSchema,
          model: { type: 'string' },
          temperature: { type: 'number', minimum: 0, maximum: 2 },
          maxOutputTokens: { type: 'integer', minimum: 1 },
          systemInstruction: { type: 'string', minLength: 1, maxLength: 8192 },
          history: historySchema,
          thinkingBudget: { type: 'integer', minimum: 0, maximum: 24576 },
        },
      },
    },
  }, async (request, reply) => {
    const { prompt, images, files, model, temperature, maxOutputTokens,
      systemInstruction, history, thinkingBudget } = request.body;

    if (!prompt && (!images || images.length === 0) && (!files || files.length === 0)) {
      reply.status(400);
      return { error: 'Either prompt, images, or files (or a combination) must be provided', code: 'BAD_REQUEST' };
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

    // Parse files (PDF → inline binary part, Excel/CSV → extracted text)
    let parsedFiles;
    if (files?.length) {
      try {
        parsedFiles = files.map(f => parseFileToContent(f));
      } catch (err) {
        reply.status(400);
        return { error: err.message, code: 'BAD_REQUEST' };
      }
    }

    const options = {};
    if (temperature !== undefined) options.temperature = temperature;
    if (maxOutputTokens !== undefined) options.maxOutputTokens = maxOutputTokens;
    if (images?.length) options.images = images;
    if (parsedFiles?.length) options.files = parsedFiles;
    if (systemInstruction) options.systemInstruction = systemInstruction;
    if (history?.length) options.history = history;
    if (thinkingBudget !== undefined) options.thinkingBudget = thinkingBudget;

    const requestId = randomUUID();
    const userEmail = request.user?.email;
    const promptLength = prompt?.length ?? 0;
    const wallStart = Date.now();

    // ── Hivemind: retrieve relevant prior context for this user ────────────
    let hivemindRuntimeOn = true;
    try {
      hivemindRuntimeOn = await isHivemindRuntimeEnabled();
    } catch {
      // Redis unavailable — fall back to existing behaviour
      hivemindRuntimeOn = true;
    }
    if (hivemindRuntimeOn && isHivemindEnabled() && userEmail && prompt) {
      try {
        const embedResult = await runEmbed({ text: prompt, model: appConfig.hivemindEmbeddingModel });
        const queryVector = embedResult?.embedding?.values;
        if (queryVector) {
          const snippets = await retrieveContext(userEmail, queryVector);
          const prefix = buildContextPrefix(snippets);
          if (prefix) {
            options.systemInstruction = options.systemInstruction
              ? `${prefix}\n\n---\n\n${options.systemInstruction}`
              : prefix;
          }
        }
      } catch (err) {
        // Non-critical — proceed without hivemind
        fastify.log.warn({ err }, '[Hivemind] stream retrieve failed');
      }
    }

    // ── Model selection — mirrors orchestrator.js logic ──────────────────────
    const fallbackModels = await getFallbackModels();
    let currentModel = model ?? await getBestModel(fallbackModels);
    let fallbackIndex = fallbackModels.indexOf(currentModel); // -1 = custom model

    // Shared retry tracking (for logRequest parity with /v1/generate)
    let retries = 0;
    let lastKeyMasked = null;
    let model429Count = 0; // Consecutive 429 tracking for currentModel
    // ─────────────────────────────────────────────────────────────────────────

    for (let attempt = 0; attempt < config.maxRetries; attempt++) {
      if (attempt > 0) retries++;

      const key = await getKey();
      if (!key) {
        logRequest({ request_id: requestId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'error', retries, prompt_length: promptLength, user_email: userEmail });
        requestsTotal.inc({ model: currentModel ?? 'unknown', status: 'no_keys' });
        notifyAdminNoKeys();
        reply.status(503);
        return { error: 'No API keys available', code: 'NO_KEYS', request_id: requestId };
      }
      lastKeyMasked = maskKey(key);

      let result;
      try {
        result = await streamGenerateContent(key, currentModel, prompt ?? '', options);
        // Prevent "Unhandled 'error' event" crash if the stream is destroyed or aborted
        result.bodyStream?.on('error', (err) => {
          fastify.log.warn({ err }, '[stream] bodyStream error');
        });
      } catch (err) {
        await returnKey(key);

        if (err.code === 'TIMEOUT') {
          await recordFailure(currentModel, 'timeout');
          logError({ type: 'timeout', model: currentModel, key_masked: lastKeyMasked, message: err.message, user_email: userEmail });
          modelTimeoutsTotal.inc({ model: currentModel });
          recordFailureRateTick().catch(() => {});

          // Fall back to next lighter model — same logic as orchestrator.js
          if (fallbackIndex === -1) {
            fallbackIndex = 0;
            currentModel = fallbackModels[0] ?? null;
          } else {
            fallbackIndex++;
            currentModel = fallbackModels[fallbackIndex] ?? null;
          }
          model429Count = 0; // Reset counter for new model
          if (!currentModel) break;
          continue;
        }

        logError({ type: 'other', model: currentModel, key_masked: lastKeyMasked, message: err.message });
        logRequest({ request_id: requestId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'error', retries, prompt_length: promptLength, user_email: userEmail });
        requestsTotal.inc({ model: currentModel, status: 'error' });
        reply.status(502);
        return { error: err.message, code: 'UPSTREAM_ERROR', request_id: requestId };
      }

      if (result.status === 429) {
        result.bodyStream.destroy();
        model429Count++;
        recordKeyFailure(lastKeyMasked).catch(() => {});
        if (model429Count < 3) {
          logError({ type: '429', model: currentModel, key_masked: lastKeyMasked, message: `Rate limit hit ${model429Count}/3` });
          keyCooldownsTotal.inc();
          recordFailureRateTick().catch(() => {});
          await cooldownKey(key, config.cooldownMs * 2, '429_rate_limit');
          continue; // same model, rotate key
        }
        logError({ type: '429_EXHAUSTED', model: currentModel, key_masked: lastKeyMasked, message: 'Rate limit hit 3 times, switching model' });
        await cooldownKey(key, config.cooldownMs * 2, '429_exhausted'); // Still cooldown the key that triggered it
      }

      // Handle 5xx and explicit 4xx switches (400, 404)
      if ([500, 502, 503, 504, 400, 404].includes(result.status) || (result.status === 429 && model429Count >= 3)) {
        if (result.status !== 429) {
          result.bodyStream?.destroy();
          await returnKey(key);
        }
        recordKeyFailure(lastKeyMasked).catch(() => {});
        
        const type = String(result.status);
        await recordFailure(currentModel, result.status >= 500 ? '503' : 'other');
        logError({ type, model: currentModel, key_masked: lastKeyMasked });
        if (result.status === 503) model503Total.inc({ model: currentModel });
        recordFailureRateTick().catch(() => {});
        
        const remaining = fallbackIndex === -1
          ? fallbackModels
          : fallbackModels.slice(fallbackIndex + 1);
        if (remaining.length === 0) break;
        currentModel = await getBestModel(remaining);
        if (!currentModel) break;
        fallbackIndex = fallbackModels.indexOf(currentModel);
        model429Count = 0; // Reset counter for new model
        continue;
      }

      if (result.status === 401 || result.status === 403) {
        result.bodyStream.destroy();
        await disableKey(key, 'key_invalid');
        recordKeyFailure(lastKeyMasked).catch(() => {});
        logError({ type: 'key_invalid', model: currentModel, key_masked: lastKeyMasked, message: `Status ${result.status}: API Key is invalid` });
        recordFailureRateTick().catch(() => {});
        continue; // try next key
      }

      if (result.status !== 200) {
        result.bodyStream.destroy();
        await returnKey(key);
        await recordFailure(currentModel, 'other');
        logError({ type: String(result.status), model: currentModel, key_masked: lastKeyMasked, message: `Streaming error status: ${result.status}` });
        logRequest({ request_id: requestId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'error', retries, prompt_length: promptLength, user_email: userEmail });
        requestsTotal.inc({ model: currentModel, status: String(result.status) });
        reply.status(result.status >= 400 && result.status < 600 ? result.status : 502);
        return { error: 'Gemini API error', code: String(result.status), request_id: requestId };
      }

      // ── Success — stream back to client ────────────────────────────────────
      await returnKey(key);
      await recordSuccess(currentModel, Date.now() - wallStart);
      recordKeySuccess(lastKeyMasked).catch(() => {});
      model429Count = 0; // Success -> reset counter
      requestsTotal.inc({ model: currentModel, status: 'success' });
      requestDuration.observe({ model: currentModel }, Date.now() - wallStart);
      if (retries > 0) retriesTotal.inc({ model: currentModel }, retries);

      reply.hijack();

      const res = reply.raw;

      // Disable Nagle's algorithm — prevents OS from batching small SSE chunks
      // into larger TCP packets, causing multi-second delivery delays.
      res.socket?.setNoDelay?.(true);

      // CORS — @fastify/cors onSend hook is skipped after hijack(), set manually.
      const requestOrigin = request.headers.origin;
      const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3001')
        .split(',').map(o => o.trim()).filter(Boolean);
      const corsOrigin = allowedOrigins.includes(requestOrigin)
        ? requestOrigin
        : (allowedOrigins[0] || 'http://localhost:3001');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': requestId,
        'X-Model-Used': currentModel,
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Credentials': 'true',
      });

      // Flush headers to client immediately — headers are lazy in Node.js HTTP.
      res.write(': ok\n\n');

      let streamStatus = 'success';
      let streamedText = '';  // Accumulate for hivemind storage
      try {
        for await (const chunk of result.bodyStream) {
          if (res.writableEnded) break;
          if (!chunk || chunk.length === 0) continue;

          // Capture text for hivemind (lightweight — only first 300 chars)
          if (streamedText.length < 300) {
            const str = chunk.toString();
            // Extract text from SSE data lines: data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}
            const matches = str.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
            for (const m of matches) {
              if (streamedText.length < 300) {
                try { streamedText += JSON.parse(`"${m[1]}"`); } catch { /* skip */ }
              }
            }
          }

          // write() returns false when kernel send-buffer is full (backpressure).
          const ok = res.write(chunk);
          if (!ok) {
            await new Promise((resolve) => {
              const onDrain = () => { cleanup(); resolve(); };
              const onClose = () => { cleanup(); resolve(); };
              const cleanup = () => {
                res.removeListener('drain', onDrain);
                res.removeListener('close', onClose);
              };
              res.once('drain', onDrain);
              res.once('close', onClose);
            });
            if (res.writableEnded) break;
          }
        }
      } catch (streamErr) {
        streamStatus = 'error';
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: 'Stream interrupted', code: 'STREAM_ERROR' })}\n\n`);
        }
      } finally {
        if (!res.writableEnded) res.end();

        // ── Hivemind: store prompt+response for future context (fire-and-forget)
        if (hivemindRuntimeOn && isHivemindEnabled() && userEmail && prompt && streamedText && streamStatus === 'success') {
          const snippet = prompt.slice(0, 200) + '\n---\n' + streamedText.slice(0, 300);
          runEmbed({ text: snippet, model: appConfig.hivemindEmbeddingModel })
            .then(r => {
              const vector = r?.embedding?.values;
              if (vector) return storeContext(userEmail, snippet, vector);
            })
            .catch(() => {});
        }

        // Log to MongoDB so /v1/usage and /v1/logs include stream requests —
        // without this, stream requests are invisible to analytics even though
        // they count against quota (incrementUserUsage fires in the preHandler).
        logRequest({
          request_id: requestId,
          model: currentModel,
          api_key_masked: lastKeyMasked,
          latency_ms: Date.now() - wallStart,
          status: streamStatus,
          retries,
          prompt_length: promptLength,
          user_email: userEmail,
        });
      }
      return;
    }

    // All retries exhausted
    logRequest({ request_id: requestId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'exhausted', retries, prompt_length: promptLength, user_email: userEmail });
    requestsTotal.inc({ model: currentModel ?? 'unknown', status: 'exhausted' });
    reply.status(503);
    return { error: 'All retries exhausted', code: 'RETRIES_EXHAUSTED', request_id: requestId };
  });
}
