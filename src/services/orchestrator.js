import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getKey, returnKey, cooldownKey } from '../redis/keyPool.js';
import { generateContent } from './gemini.js';
import { recordSuccess, recordFailure, getBestModel } from '../redis/modelHealth.js';
import { getFallbackModels } from '../redis/modelConfig.js';
import { logRequest, logError } from '../db/logger.js';
import { notifyAdminNoKeys } from './notifications.js';
import { recordFailureRateTick } from '../redis/systemConfig.js';
import {
  requestsTotal,
  requestDuration,
  retriesTotal,
  keyCooldownsTotal,
  model503Total,
  modelTimeoutsTotal,
} from '../metrics/index.js';

export function maskKey(key) {
  if (!key || key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
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

  // Load the current fallback chain (admin-configurable, stored in Redis)
  const fallbackModels = await getFallbackModels();

  // If the user specified a model, start with it.
  // Otherwise pick the healthiest model from the fallback chain.
  let currentModel = model ?? await getBestModel(fallbackModels);

  // Track position inside the fallback chain.
  // -1 means we are currently on a user-specified model that is not in the chain.
  let fallbackIndex = fallbackModels.indexOf(currentModel);

  let lastError = null;
  let retries = 0;
  let lastKeyMasked = null;

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    if (attempt > 0) retries++;

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
      logRequest({ request_id: reqId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: result.latencyMs, status: 'success', retries, prompt_length: prompt?.length ?? 0, usage_metadata: result.data?.usageMetadata, user_email: userEmail });
      requestsTotal.inc({ model: currentModel, status: 'success' });
      requestDuration.observe({ model: currentModel }, Date.now() - wallStart);
      if (retries > 0) retriesTotal.inc({ model: currentModel }, retries);
      return {
        text: result.data?.candidates?.[0]?.content?.parts?.[0]?.text,
        model: currentModel,
        usageMetadata: result.data?.usageMetadata,
        request_id: reqId,
        retries,
        latency_ms: result.latencyMs,
      };
    }

    if (result.status === 429) {
      await cooldownKey(key, config.cooldownMs);
      logError({ type: '429', model: currentModel, key_masked: lastKeyMasked });
      keyCooldownsTotal.inc();
      recordFailureRateTick().catch(() => {});
      lastError = '429';
      continue; // same model, just need a fresh key
    }

    if (result.status === 503) {
      await returnKey(key);
      await recordFailure(currentModel, '503');
      logError({ type: '503', model: currentModel, key_masked: lastKeyMasked });
      model503Total.inc({ model: currentModel });
      recordFailureRateTick().catch(() => {});
      lastError = '503';

      let remaining;
      if (fallbackIndex === -1) {
        // User's custom model got 503 → try all fallback models
        remaining = fallbackModels;
      } else {
        // Skip the models we've already tried
        remaining = fallbackModels.slice(fallbackIndex + 1);
      }

      if (remaining.length === 0) break;
      currentModel = await getBestModel(remaining);
      if (!currentModel) break;
      fallbackIndex = fallbackModels.indexOf(currentModel);
      continue;
    }

    // Other API error (400, 401, 404, etc.) — return immediately, no retry
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
