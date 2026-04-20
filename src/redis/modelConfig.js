import { getRedis } from './client.js';
import { savePersistentConfig, getPersistentConfig } from '../db/config.js';

const CONFIG_KEY = 'model:config';

// Default fallback chain — most capable to lightest.
// Used when no admin override is stored in Redis.
export const DEFAULT_FALLBACK_MODELS = [
  'gemini-3.1-flash-lite-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];

// Default image generation models — models that support responseModalities: ["IMAGE", "TEXT"]
export const DEFAULT_IMAGE_MODELS = [
  'gemini-2.5-flash-image'
];

/**
 * Get the current fallback model list from Redis.
 * Falls back to DEFAULT_FALLBACK_MODELS if not configured.
 */
export async function getFallbackModels() {
  const redis = getRedis();
  const raw = await redis.hget(CONFIG_KEY, 'fallback_models');
  if (!raw) return [...DEFAULT_FALLBACK_MODELS];
  try { return JSON.parse(raw); } catch { return [...DEFAULT_FALLBACK_MODELS]; }
}

/**
 * Get image generation models from Redis.
 * Falls back to DEFAULT_IMAGE_MODELS if not configured.
 */
export async function getImageModels() {
  const redis = getRedis();
  const raw = await redis.hget(CONFIG_KEY, 'image_models');
  if (!raw) return [...DEFAULT_IMAGE_MODELS];
  try { return JSON.parse(raw); } catch { return [...DEFAULT_IMAGE_MODELS]; }
}

/**
 * Get the full model config: primary_model (first in list) and fallback_models.
 */
export async function getModelConfig() {
  const fallback_models = await getFallbackModels();
  return {
    primary_model:  fallback_models[0] ?? null,
    fallback_models,
  };
}

/**
 * Update model config.
 * - fallbackModels: replaces the entire fallback chain
 * - primaryModel:   moves this model to position 0 (adds if not present)
 * If both provided, fallbackModels is applied first, then primaryModel reorders.
 */
export async function updateModelConfig({ primaryModel, fallbackModels } = {}) {
  let models = fallbackModels ? [...fallbackModels] : await getFallbackModels();

  if (primaryModel !== undefined) {
    const idx = models.indexOf(primaryModel);
    if (idx > 0) models.splice(idx, 1);        // remove from current position
    if (!models.includes(primaryModel)) models.unshift(primaryModel); // add at front
    // idx === 0: already primary, no change needed
  }

  await getRedis().hset(CONFIG_KEY, 'fallback_models', JSON.stringify(models));
  
  // Persist to MongoDB
  await savePersistentConfig('models', { fallback_models: models });
}

/**
 * Load model configuration from MongoDB into Redis.
 * @param {import('ioredis').Redis} [client]
 */
export async function loadModelConfigFromDb(client) {
  const redis = client || getRedis();
  const doc = await getPersistentConfig('models');
  if (doc && doc.fallback_models) {
    await redis.hset(CONFIG_KEY, 'fallback_models', JSON.stringify(doc.fallback_models));
    return true;
  }
  return false;
}

/**
 * Add a model to the fallback chain.
 * @param {string} model
 * @param {'start'|'end'} position  Default: 'end'
 */
export async function addFallbackModel(model, position = 'end') {
  const models = await getFallbackModels();
  if (models.includes(model)) return { added: false, reason: 'already_exists' };
  if (position === 'start') models.unshift(model);
  else models.push(model);
  await getRedis().hset(CONFIG_KEY, 'fallback_models', JSON.stringify(models));
  await savePersistentConfig('models', { fallback_models: models });
  return { added: true };
}

/**
 * Remove a model from the fallback chain.
 */
export async function removeFallbackModel(model) {
  const models = await getFallbackModels();
  const idx = models.indexOf(model);
  if (idx === -1) return { removed: false, reason: 'not_found' };
  models.splice(idx, 1);
  await getRedis().hset(CONFIG_KEY, 'fallback_models', JSON.stringify(models));
  await savePersistentConfig('models', { fallback_models: models });
  return { removed: true };
}
