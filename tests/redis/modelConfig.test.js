import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRedis } from '../helpers/mocks.js';

const mockRedis = createMockRedis();
vi.mock('../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));
vi.mock('../../src/db/config.js', () => ({
  savePersistentConfig: vi.fn().mockResolvedValue(undefined),
  getPersistentConfig: vi.fn().mockResolvedValue(null),
}));

import {
  getFallbackModels, getImageModels, getModelConfig,
  updateModelConfig, addFallbackModel, removeFallbackModel,
  DEFAULT_FALLBACK_MODELS,
} from '../../src/redis/modelConfig.js';

describe('getFallbackModels()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return default models when Redis has no config', async () => {
    mockRedis.hget.mockResolvedValue(null);
    const models = await getFallbackModels();
    expect(models).toEqual(DEFAULT_FALLBACK_MODELS);
  });

  it('should return stored models from Redis', async () => {
    mockRedis.hget.mockResolvedValue(JSON.stringify(['model-x', 'model-y']));
    const models = await getFallbackModels();
    expect(models).toEqual(['model-x', 'model-y']);
  });

  it('should return defaults on parse error', async () => {
    mockRedis.hget.mockResolvedValue('invalid-json');
    const models = await getFallbackModels();
    expect(models).toEqual(DEFAULT_FALLBACK_MODELS);
  });
});

describe('getModelConfig()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return primary_model and fallback_models', async () => {
    mockRedis.hget.mockResolvedValue(JSON.stringify(['model-a', 'model-b']));
    const config = await getModelConfig();
    expect(config.primary_model).toBe('model-a');
    expect(config.fallback_models).toEqual(['model-a', 'model-b']);
  });
});

describe('addFallbackModel()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should add a new model to the end', async () => {
    mockRedis.hget.mockResolvedValue(JSON.stringify(['model-a']));
    mockRedis.hset.mockResolvedValue(1);
    const result = await addFallbackModel('model-b');
    expect(result.added).toBe(true);
  });

  it('should return already_exists for duplicate', async () => {
    mockRedis.hget.mockResolvedValue(JSON.stringify(['model-a']));
    const result = await addFallbackModel('model-a');
    expect(result.added).toBe(false);
    expect(result.reason).toBe('already_exists');
  });
});

describe('removeFallbackModel()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should remove existing model', async () => {
    mockRedis.hget.mockResolvedValue(JSON.stringify(['model-a', 'model-b']));
    mockRedis.hset.mockResolvedValue(1);
    const result = await removeFallbackModel('model-a');
    expect(result.removed).toBe(true);
  });

  it('should return not_found for missing model', async () => {
    mockRedis.hget.mockResolvedValue(JSON.stringify(['model-a']));
    const result = await removeFallbackModel('model-x');
    expect(result.removed).toBe(false);
    expect(result.reason).toBe('not_found');
  });
});
