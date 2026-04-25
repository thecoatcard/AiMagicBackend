import { randomUUID, createHash } from 'crypto';
import { config } from '../config.js';
import { getKey, returnKey, cooldownKey, disableKey, recordKeySuccess, recordKeyFailure, isPoolExhausted } from '../redis/keyPool.js';
import { generateContent, embedContent, batchEmbedContents, generateImage } from './gemini.js';
import { recordSuccess, recordFailure, getBestModel } from '../redis/modelHealth.js';
import { getActiveFallbackModels, getImageModels } from '../redis/modelConfig.js';
import { logRequest, logError } from '../db/logger.js';
import { notifyAdminNoKeys } from './notifications.js';
import { recordFailureRateTick, isHivemindRuntimeEnabled } from '../redis/systemConfig.js';
import { isHivemindEnabled, retrieveContext, storeContext, buildContextPrefix } from './hivemind.js';
import { getRedis } from '../redis/client.js';
import {
  requestsTotal,
  requestDuration,
  retriesTotal,
  keyCooldownsTotal,
  model503Total,
  modelTimeoutsTotal,
  hivemindEmbeddingsTotal,
} from '../metrics/index.js';

// Error-type-specific cooldown durations
const COOLDOWN_429 = config.cooldownMs * 2;       // 429 rate limit → longer cooldown (2x)
const COOLDOWN_503 = Math.round(config.cooldownMs * 0.5); // 503 server error → shorter cooldown (0.5x)
const COOLDOWN_DEFAULT = config.cooldownMs;        // Default cooldown

export function maskKey(key) {
  if (!key || key.length <= 8) return '****';
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 6);
  return key.slice(0, 4) + '…' + hash + '…' + key.slice(-4);
}

/**
 * Core generate-with-retry logic shared by the HTTP route and BullMQ worker.
 *
 * Model selection strategy:
 *  - User specifies model  → try it first; on timeout/503 fall back to the
 *    configured fallback chain (even if the model isn't in it).
 *  - User omits model      → pick the healthiest model in the fallback chain.
 *
 * The fallback chain is admin-configurable via PATCH /v1/models/config.
 */
export async function runGenerate({ prompt, model, options = {}, requestId, userEmail } = {}) {
  const reqId = requestId ?? randomUUID();
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
      const embedResult = await _embedForHivemind(prompt);
      if (embedResult) {
        const snippets = await retrieveContext(userEmail, embedResult);
        const prefix = buildContextPrefix(snippets);
        if (prefix) {
          options.systemInstruction = options.systemInstruction
            ? `${prefix}\n\n---\n\n${options.systemInstruction}`
            : prefix;
        }
      }
    } catch (err) {
      // Non-critical — proceed without hivemind context
      console.warn('[Hivemind] retrieve failed:', err.message);
    }
  }

  // Load the current fallback chain (admin-configurable, stored in Redis)
  const fallbackModels = await getActiveFallbackModels();

  // If the user specified a model, start with it.
  // Otherwise pick the healthiest model from the fallback chain.
  let currentModel = model ?? await getBestModel(fallbackModels);

  // Short-circuit: admin may have removed every fallback model AND the caller
  // omitted `model`. Without this guard the loop would call generateContent()
  // with `null` and surface confusing upstream errors.
  if (!currentModel) {
    return { error: 'No models available', code: 'NO_MODELS', request_id: reqId, httpStatus: 503 };
  }

  // Track position inside the fallback chain.
  // -1 means we are currently on a user-specified model that is not in the chain.
  let fallbackIndex = fallbackModels.indexOf(currentModel);

  let lastError = null;
  let retries = 0;
  let lastKeyMasked = null;
  let model429Count = 0; // Consecutive 429 tracking for currentModel

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    if (attempt > 0) retries++;

    // Circuit breaker: fast-fail if pool is completely exhausted
    if (attempt > 0 && await isPoolExhausted()) {
      logRequest({ request_id: reqId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'error', retries, prompt_length: prompt?.length ?? 0, user_email: userEmail });
      requestsTotal.inc({ model: currentModel ?? 'unknown', status: 'pool_exhausted' });
      notifyAdminNoKeys();
      return { error: 'Key pool exhausted — all keys in cooldown', code: 'POOL_EXHAUSTED', request_id: reqId, httpStatus: 503 };
    }

    const key = await getKey();
    if (!key) {
      logRequest({ request_id: reqId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'error', retries, prompt_length: prompt?.length ?? 0, user_email: userEmail });
      requestsTotal.inc({ model: currentModel ?? 'unknown', status: 'no_keys' });
      notifyAdminNoKeys();
      return { error: 'No API keys available', code: 'NO_KEYS', request_id: reqId, httpStatus: 503 };
    }
    lastKeyMasked = maskKey(key);

    let result;
    try {
      result = await generateContent(key, currentModel, prompt, options);
    } catch (err) {
      await returnKey(key);

      if (err.code === 'TIMEOUT') {
        await recordFailure(currentModel, 'timeout');
        logError({ type: 'timeout', model: currentModel, key_masked: lastKeyMasked, message: err.message });
        modelTimeoutsTotal.inc({ model: currentModel });
        recordFailureRateTick().catch(() => {});
        lastError = 'timeout';

        if (fallbackIndex === -1) {
          // User's custom model timed out → start from beginning of fallback chain
          fallbackIndex = 0;
          currentModel = fallbackModels[0] ?? null;
        } else {
          // Advance to next lighter model in chain
          fallbackIndex++;
          currentModel = fallbackModels[fallbackIndex] ?? null;
        }
        model429Count = 0; // Reset counter for new model
        if (!currentModel) break;
        continue;
      }

      await recordFailure(currentModel, 'other');
      logError({ type: 'other', model: currentModel, key_masked: lastKeyMasked, message: err.message });
      logRequest({ request_id: reqId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'error', retries, prompt_length: prompt?.length ?? 0, user_email: userEmail });
      requestsTotal.inc({ model: currentModel, status: 'error' });
      return { error: err.message, code: 'UPSTREAM_ERROR', request_id: reqId, httpStatus: 502 };
    }

    if (result.status === 200) {
      await returnKey(key);
      await recordSuccess(currentModel, result.latencyMs);
      recordKeySuccess(lastKeyMasked).catch(() => {});
      model429Count = 0; // Success -> reset counter
      logRequest({ request_id: reqId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: result.latencyMs, status: 'success', retries, prompt_length: prompt?.length ?? 0, usage_metadata: result.data?.usageMetadata, user_email: userEmail });
      requestsTotal.inc({ model: currentModel, status: 'success' });
      requestDuration.observe({ model: currentModel }, Date.now() - wallStart);
      if (retries > 0) retriesTotal.inc({ model: currentModel }, retries);
      const parts = result.data?.candidates?.[0]?.content?.parts || [];
      let responseText = parts
        .filter(p => !p.thought)
        .map(p => p.text || '')
        .join('') || '';
      
      if (currentModel.startsWith('gemma-4')) {
        responseText = responseText.replace(/(?:<\|channel>thought|<(?:think|thought)>)[\s\S]*?(?:<channel\|>|<\/(?:think|thought)>|$)/gi, '').trim();
      }

      // ── Hivemind: store prompt+response for future context retrieval ────
      if (hivemindRuntimeOn && isHivemindEnabled() && userEmail && prompt && responseText) {
        const snippet = prompt.slice(0, 200) + '\n---\n' + responseText.slice(0, 300);
        // Idempotency guard: BullMQ retries can dispatch the same logical
        // request twice. SET-NX on requestId prevents duplicate hivemind
        // entries (different UUIDs but identical content) for the same reqId.
        (async () => {
          if (reqId) {
            try {
              const guardKey = `hm:store_guard:${reqId}`;
              const acquired = await getRedis().set(guardKey, '1', 'EX', 600, 'NX');
              if (acquired !== 'OK') return; // already stored for this requestId
            } catch { /* Redis unreachable — degrade gracefully and proceed */ }
          }
          _embedAndStore(userEmail, snippet).catch(() => {});
        })();
      }

      return {
        text: responseText,
        model: currentModel,
        usageMetadata: result.data?.usageMetadata,
        request_id: reqId,
        retries,
        latency_ms: result.latencyMs,
      };
    }

    if (result.status === 429) {
      model429Count++;
      recordKeyFailure(lastKeyMasked).catch(() => {});
      if (model429Count < 3) {
        await cooldownKey(key, COOLDOWN_429, '429_rate_limit');
        logError({ type: '429', model: currentModel, key_masked: lastKeyMasked, message: `Rate limit hit ${model429Count}/3` });
        keyCooldownsTotal.inc();
        recordFailureRateTick().catch(() => {});
        lastError = '429';
        continue; // Try same model with different key
      }
      // Hit 3 times -> Fall through to model switching logic
      logError({ type: '429_EXHAUSTED', model: currentModel, key_masked: lastKeyMasked, message: 'Rate limit hit 3 times, switching model' });
      await cooldownKey(key, COOLDOWN_429, '429_exhausted'); // Still cooldown the key that triggered it
    }

    // Handle 5xx and explicit 4xx switches (400, 404)
    if ([500, 502, 503, 504, 400, 404].includes(result.status) || (result.status === 429 && model429Count >= 3)) {
      if (result.status !== 429) await returnKey(key);
      recordKeyFailure(lastKeyMasked).catch(() => {});
      
      const type = String(result.status);
      await recordFailure(currentModel, result.status >= 500 ? '503' : 'other');
      logError({ type, model: currentModel, key_masked: lastKeyMasked });
      if (result.status === 503) model503Total.inc({ model: currentModel });
      recordFailureRateTick().catch(() => {});
      lastError = type;

      let remaining;
      if (fallbackIndex === -1) {
        // User's custom model failed → try all fallback models
        remaining = fallbackModels;
      } else {
        // Skip the models we've already tried
        remaining = fallbackModels.slice(fallbackIndex + 1);
      }

      if (remaining.length === 0) break;
      currentModel = await getBestModel(remaining);
      if (!currentModel) break;
      fallbackIndex = fallbackModels.indexOf(currentModel);
      model429Count = 0; // Reset counter for new model
      continue;
    }

    if (result.status === 401 || result.status === 403) {
      await disableKey(key, 'key_invalid');
      recordKeyFailure(lastKeyMasked).catch(() => {});
      logError({ type: 'key_invalid', model: currentModel, key_masked: lastKeyMasked, message: `Status ${result.status}: API Key is invalid or revoked` });
      recordFailureRateTick().catch(() => {});
      lastError = 'key_invalid';
      continue; // try next key
    }

    // Other API error (400, 404, etc.) — return immediately, no retry
    await returnKey(key);
    await recordFailure(currentModel, 'other');
    logError({ type: String(result.status), model: currentModel, key_masked: lastKeyMasked, message: result.data?.error?.message });
    logRequest({ request_id: reqId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: result.latencyMs ?? 0, status: 'error', retries, prompt_length: prompt?.length ?? 0, user_email: userEmail });
    requestsTotal.inc({ model: currentModel, status: String(result.status) });
    return { error: result.data?.error?.message || 'Gemini API error', code: result.status, request_id: reqId, httpStatus: result.status };
  }

  logRequest({ request_id: reqId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'exhausted', retries, prompt_length: prompt?.length ?? 0, user_email: userEmail });
  requestsTotal.inc({ model: currentModel ?? 'unknown', status: 'exhausted' });
  return { error: 'All retries exhausted', lastError, code: 'RETRIES_EXHAUSTED', request_id: reqId, httpStatus: 503 };
}

/**
 * Core embedding logic with retry and key rotation.
 */
export async function runEmbed({ text, model, requestId, userEmail } = {}) {
  const reqId = requestId ?? randomUUID();
  const currentModel = model ?? 'gemini-embedding-2-preview';
  
  let lastError = null;
  let retries = 0;
  let lastKeyMasked = null;
  let model429Count = 0;

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    if (attempt > 0) retries++;

    // Circuit breaker: fast-fail if pool is completely exhausted
    if (attempt > 0 && await isPoolExhausted()) {
      logRequest({ request_id: reqId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'error', retries, user_email: userEmail });
      notifyAdminNoKeys();
      return { error: 'Key pool exhausted — all keys in cooldown', code: 'POOL_EXHAUSTED', request_id: reqId, httpStatus: 503 };
    }

    const key = await getKey();
    if (!key) {
      logRequest({ request_id: reqId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'error', retries, user_email: userEmail });
      notifyAdminNoKeys();
      return { error: 'No API keys available', code: 'NO_KEYS', request_id: reqId, httpStatus: 503 };
    }
    lastKeyMasked = maskKey(key);

    let result;
    try {
      if (Array.isArray(text)) {
        result = await batchEmbedContents(key, currentModel, text);
      } else {
        result = await embedContent(key, currentModel, text);
      }
    } catch (err) {
      await returnKey(key);
      if (err.code === 'TIMEOUT') {
        await recordFailure(currentModel, 'timeout');
        logError({ type: 'timeout', model: currentModel, key_masked: lastKeyMasked, message: err.message });
        modelTimeoutsTotal.inc({ model: currentModel });
        recordFailureRateTick().catch(() => {});
        lastError = 'timeout';
        continue;
      }
      await recordFailure(currentModel, 'other');
      logError({ type: 'other', model: currentModel, key_masked: lastKeyMasked, message: err.message });
      recordFailureRateTick().catch(() => {});
      return { error: err.message, code: 'UPSTREAM_ERROR', request_id: reqId, httpStatus: 502 };
    }

    if (result.status === 200) {
      await returnKey(key);
      await recordSuccess(currentModel, result.latencyMs);
      logRequest({ request_id: reqId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: result.latencyMs, status: 'success', retries, user_email: userEmail });
      requestsTotal.inc({ model: currentModel, status: 'success' });
      return {
        ...(result.data || {}),
        model: currentModel,
        request_id: reqId,
        retries,
        latency_ms: result.latencyMs,
      };
    }

    if (result.status === 429) {
      model429Count++;
      if (model429Count < 3) {
        await cooldownKey(key, COOLDOWN_429, '429_rate_limit');
        logError({ type: '429', model: currentModel, key_masked: lastKeyMasked });
        keyCooldownsTotal.inc();
        recordFailureRateTick().catch(() => {});
        lastError = '429';
        continue;
      }
      await cooldownKey(key, COOLDOWN_429, '429_exhausted');
      logError({ type: '429_EXHAUSTED', model: currentModel, key_masked: lastKeyMasked });
      break; // No fallback chain for embeddings yet
    }

    if ([500, 502, 503, 504, 400, 404].includes(result.status)) {
      await returnKey(key);
      await recordFailure(currentModel, result.status >= 500 ? '503' : 'other');
      logError({ type: String(result.status), model: currentModel, key_masked: lastKeyMasked });
      if (result.status === 503) model503Total.inc({ model: currentModel });
      recordFailureRateTick().catch(() => {});
      lastError = String(result.status);
      continue;
    }

    if (result.status === 401 || result.status === 403) {
      await disableKey(key, 'key_invalid');
      logError({ type: 'key_invalid', model: currentModel, key_masked: lastKeyMasked });
      recordFailureRateTick().catch(() => {});
      lastError = 'key_invalid';
      continue;
    }

    await returnKey(key);
    logError({ type: String(result.status), model: currentModel, key_masked: lastKeyMasked, message: result.data?.error?.message });
    return { error: result.data?.error?.message || 'Gemini API error', code: result.status, request_id: reqId, httpStatus: result.status };
  }

  logRequest({ request_id: reqId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'exhausted', retries, user_email: userEmail });
  return { error: 'All retries exhausted', lastError, code: 'RETRIES_EXHAUSTED', request_id: reqId, httpStatus: 503 };
}

/**
 * Image generation with full key rotation, model fallback, and retry.
 * Uses dedicated image models that support responseModalities: ["IMAGE", "TEXT"].
 */
export async function runImageGeneration({ prompt, options = {}, requestId, userEmail } = {}) {
  const reqId = requestId ?? randomUUID();
  const wallStart = Date.now();

  const imageModels = await getImageModels();
  if (!imageModels || imageModels.length === 0) {
    return { error: 'No image generation models configured', code: 'NO_IMAGE_MODELS', request_id: reqId, httpStatus: 503 };
  }
  let currentModel = imageModels[0];
  let modelIndex = 0;

  let lastKeyMasked = null;
  let retries = 0;
  let lastError = null;
  let model429Count = 0;

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    if (attempt > 0) retries++;

    const key = await getKey();
    if (!key) {
      notifyAdminNoKeys();
      return { error: 'No API keys available', code: 'NO_KEYS', request_id: reqId, httpStatus: 503 };
    }
    lastKeyMasked = maskKey(key);

    let result;
    try {
      result = await generateImage(key, currentModel, prompt, options);
    } catch (err) {
      await returnKey(key);
      if (err.code === 'TIMEOUT') {
        await recordFailure(currentModel, 'timeout');
        logError({ type: 'timeout', model: currentModel, key_masked: lastKeyMasked, message: err.message, user_email: userEmail });
        lastError = 'timeout';
        // Advance to next image model
        modelIndex++;
        currentModel = imageModels[modelIndex] ?? null;
        model429Count = 0;
        if (!currentModel) break;
        continue;
      }
      return { error: err.message, code: 'UPSTREAM_ERROR', request_id: reqId, httpStatus: 502 };
    }

    if (result.status === 200) {
      await returnKey(key);
      await recordSuccess(currentModel, result.latencyMs);
      recordKeySuccess(lastKeyMasked).catch(() => {});

      // Extract images from Gemini generateContent response
      const parts = result.data?.candidates?.[0]?.content?.parts ?? [];
      const images = [];
      let textResponse = '';
      for (const part of parts) {
        if (part.inlineData?.data) {
          images.push(part.inlineData.data);
        }
        if (part.text) {
          textResponse += part.text;
        }
      }

      return { images, text: textResponse, model: currentModel, request_id: reqId, latency_ms: result.latencyMs };
    }

    if (result.status === 429) {
      model429Count++;
      recordKeyFailure(lastKeyMasked).catch(() => {});
      await cooldownKey(key, COOLDOWN_429, '429_rate_limit');
      if (model429Count < 3) {
        lastError = '429';
        continue; // same model, rotate key
      }
      // 3 strikes — fall through to model switch
      logError({ type: '429_EXHAUSTED', model: currentModel, key_masked: lastKeyMasked });
    }

    if ([500, 502, 503, 504, 400, 404].includes(result.status) || (result.status === 429 && model429Count >= 3)) {
      if (result.status !== 429) await returnKey(key);
      recordKeyFailure(lastKeyMasked).catch(() => {});
      await recordFailure(currentModel, result.status >= 500 ? '503' : 'other');
      logError({ type: String(result.status), model: currentModel, key_masked: lastKeyMasked });
      lastError = String(result.status);

      modelIndex++;
      currentModel = imageModels[modelIndex] ?? null;
      if (!currentModel) break;
      model429Count = 0;
      continue;
    }

    if (result.status === 401 || result.status === 403) {
      recordKeyFailure(lastKeyMasked).catch(() => {});
      await disableKey(key, 'key_invalid');
      lastError = 'key_invalid';
      continue; // try next key, same model
    }

    await returnKey(key);
    recordKeyFailure(lastKeyMasked).catch(() => {});
    const errMsg = result.data?.error?.message || 'Image generation failed';
    return { error: errMsg, code: String(result.status), request_id: reqId, httpStatus: result.status };
  }

  return { error: 'All retries exhausted', lastError, code: 'RETRIES_EXHAUSTED', request_id: reqId, httpStatus: 503 };
}

// ── Hivemind internal helpers (fire-and-forget, non-critical) ────────────────

/**
 * Embed text for hivemind using the configured embedding model.
 * Uses internal key rotation via runEmbed.
 * @returns {Promise<number[]|null>} - Embedding vector or null on failure
 */
async function _embedForHivemind(text) {
  const result = await runEmbed({ text, model: config.hivemindEmbeddingModel });
  if (result.error) {
    try { hivemindEmbeddingsTotal.inc({ operation: 'retrieve', status: 'failure' }); } catch { /* metrics outage */ }
    return null;
  }
  try { hivemindEmbeddingsTotal.inc({ operation: 'retrieve', status: 'success' }); } catch { /* metrics outage */ }
  return result.embedding?.values ?? null;
}

/**
 * Embed a snippet and store it in hivemind Redis (fire-and-forget).
 */
async function _embedAndStore(userEmail, snippet) {
  try {
    const result = await runEmbed({ text: snippet, model: config.hivemindEmbeddingModel });
    if (result.error) {
      try { hivemindEmbeddingsTotal.inc({ operation: 'store', status: 'failure' }); } catch { /* metrics outage */ }
      return;
    }
    try { hivemindEmbeddingsTotal.inc({ operation: 'store', status: 'success' }); } catch { /* metrics outage */ }
    const vector = result.embedding?.values ?? null;
    if (vector) await storeContext(userEmail, snippet, vector);
  } catch (err) {
    try { hivemindEmbeddingsTotal.inc({ operation: 'store', status: 'failure' }); } catch { /* metrics outage */ }
    console.warn('[Hivemind] embedAndStore error:', err.message);
  }
}
