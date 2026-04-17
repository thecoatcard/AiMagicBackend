import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getKey, returnKey, cooldownKey, disableKey } from '../redis/keyPool.js';
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
 * Core retry/fallback loop for all AI requests.
 * @param {string} actionType - 'generate' or 'stream'
 */
async function runAIAction(actionType, { prompt, model, options = {}, requestId, userEmail } = {}) {
  const reqId = requestId ?? randomUUID();
  const wallStart = Date.now();

  // Load the current fallback chain (admin-configurable, stored in Redis)
  const fallbackModels = await getFallbackModels();

  // If the user specified a model, start with it.
  // Otherwise pick the healthiest model from the fallback chain.
  let currentModel = model ?? await getBestModel(fallbackModels);

  // Track position inside the fallback chain (-1 = custom model not in chain)
  let fallbackIndex = fallbackModels.indexOf(currentModel);

  let lastError = null;
  let retries = 0;
  let lastKeyMasked = null;
  let consecutive429s = 0;

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
      if (actionType === 'stream') {
        result = await import('./gemini.js').then(m => m.streamGenerateContent(key, currentModel, prompt, options));
      } else {
        result = await generateContent(key, currentModel, prompt, options);
      }
    } catch (err) {
      await returnKey(key);
      const isTimeout = err.code === 'TIMEOUT';
      
      logError({ type: isTimeout ? 'timeout' : 'other', model: currentModel, key_masked: lastKeyMasked, message: err.message });
      if (isTimeout) {
        await recordFailure(currentModel, 'timeout');
        modelTimeoutsTotal.inc({ model: currentModel });
      } else {
        await recordFailure(currentModel, 'other');
      }
      
      recordFailureRateTick().catch(() => {});
      lastError = isTimeout ? 'TIMEOUT' : 'EXCEPTION';

      // Fall back to next model on ANY catchable error (timeout or unhandled exception)
      if (fallbackIndex === -1) {
        fallbackIndex = 0;
        currentModel = fallbackModels[0] ?? null;
      } else {
        fallbackIndex++;
        currentModel = fallbackModels[fallbackIndex] ?? null;
      }
      consecutive429s = 0; // Reset on model switch
      if (!currentModel) break;
      continue;
    }

    const status = result.status;

    if (status === 200) {
      if (actionType === 'generate') {
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
      } else {
        // For streaming, the caller handles returnKey, recordSuccess, and final logging.
        // We return everything needed to continue the stream.
        return { 
          status: 200, 
          bodyStream: result.bodyStream, 
          model: currentModel, 
          key, 
          lastKeyMasked, 
          retries, 
          reqId, 
          wallStart 
        };
      }
    }

    // Handle API Error Status Codes
    if (actionType === 'stream' && result.bodyStream) {
      result.bodyStream.destroy();
    }

    if (status === 429) {
      await cooldownKey(key, config.cooldownMs);
      logError({ type: '429', model: currentModel, key_masked: lastKeyMasked });
      keyCooldownsTotal.inc();
      recordFailureRateTick().catch(() => {});
      lastError = '429';
      consecutive429s++;

      // If we hit 3 consecutive 429s on this model across different keys, 
      // it's likely a global model quota issue — fall back to next model.
      if (consecutive429s >= 3) {
        consecutive429s = 0;
        if (fallbackIndex === -1) {
          fallbackIndex = 0;
          currentModel = fallbackModels[0] ?? null;
        } else {
          fallbackIndex++;
          currentModel = fallbackModels[fallbackIndex] ?? null;
        }
        if (!currentModel) break;
      }
      continue;
    }

    if (status === 401 || status === 403) {
      await disableKey(key);
      logError({ type: 'key_invalid', model: currentModel, key_masked: lastKeyMasked, message: `Status ${status}: API Key is invalid` });
      recordFailureRateTick().catch(() => {});
      lastError = 'key_invalid';
      continue; // try next key for same model
    }

    // Statuses that trigger a model fallback per user request: 
    // - 5xx (Server errors)
    // - 404 (Model not found/deprecated)
    // - 400 (Sometimes model-specific parameter issues)
    const shouldFallback = [500, 502, 503, 504, 404, 400].includes(status);
    
    if (shouldFallback) {
      await returnKey(key);
      await recordFailure(currentModel, String(status));
      logError({ type: String(status), model: currentModel, key_masked: lastKeyMasked });
      if (status === 503) model503Total.inc({ model: currentModel });
      recordFailureRateTick().catch(() => {});
      lastError = String(status);

      let remaining;
      if (fallbackIndex === -1) {
        remaining = fallbackModels;
      } else {
        remaining = fallbackModels.slice(fallbackIndex + 1);
      }

      if (remaining.length === 0) break;
      currentModel = await getBestModel(remaining);
      if (!currentModel) break;
      fallbackIndex = fallbackModels.indexOf(currentModel);
      consecutive429s = 0; // Reset on model switch
      continue;
    }

    // Other non-retryable API errors
    await returnKey(key);
    await recordFailure(currentModel, 'other');
    logError({ type: String(status), model: currentModel, key_masked: lastKeyMasked, message: result.data?.error?.message });
    logRequest({ request_id: reqId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: result.latencyMs ?? 0, status: 'error', retries, prompt_length: prompt?.length ?? 0, user_email: userEmail });
    requestsTotal.inc({ model: currentModel, status: String(status) });
    return { error: result.data?.error?.message || 'Gemini API error', code: status, request_id: reqId, httpStatus: status };
  }

  logRequest({ request_id: reqId, model: currentModel, api_key_masked: lastKeyMasked, latency_ms: 0, status: 'exhausted', retries, prompt_length: prompt?.length ?? 0, user_email: userEmail });
  requestsTotal.inc({ model: currentModel ?? 'unknown', status: 'exhausted' });
  return { error: 'All retries exhausted', lastError, code: 'RETRIES_EXHAUSTED', request_id: reqId, httpStatus: 503 };
}

/**
 * Public entry point for unary generation.
 */
export async function runGenerate(params) {
  return runAIAction('generate', params);
}

/**
 * Public entry point for streaming generation.
 */
export async function runStream(params) {
  return runAIAction('stream', params);
}

