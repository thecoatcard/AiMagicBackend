import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { cooldownMs: 60000, maxRetries: 3, requestTimeoutMs: 30000 },
}));
vi.mock('../../src/redis/keyPool.js', () => ({
  getKey: vi.fn(),
  returnKey: vi.fn(),
  cooldownKey: vi.fn(),
  disableKey: vi.fn(),
  recordKeySuccess: vi.fn().mockResolvedValue(undefined),
  recordKeyFailure: vi.fn().mockResolvedValue(undefined),
  isPoolExhausted: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/services/gemini.js', () => ({
  generateContent: vi.fn(),
  embedContent: vi.fn(),
  batchEmbedContents: vi.fn(),
  generateImage: vi.fn(),
}));
vi.mock('../../src/redis/modelHealth.js', () => ({
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  getBestModel: vi.fn(),
}));
vi.mock('../../src/redis/modelConfig.js', () => ({
  getFallbackModels: vi.fn().mockResolvedValue(['model-a', 'model-b']),
  getImageModels: vi.fn().mockResolvedValue(['img-model']),
}));
vi.mock('../../src/db/logger.js', () => ({
  logRequest: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../../src/services/notifications.js', () => ({
  notifyAdminNoKeys: vi.fn(),
}));
vi.mock('../../src/redis/systemConfig.js', () => ({
  recordFailureRateTick: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/metrics/index.js', () => ({
  requestsTotal: { inc: vi.fn() },
  requestDuration: { observe: vi.fn() },
  retriesTotal: { inc: vi.fn() },
  keyCooldownsTotal: { inc: vi.fn() },
  model503Total: { inc: vi.fn() },
  modelTimeoutsTotal: { inc: vi.fn() },
}));

import { runGenerate, maskKey } from '../../src/services/orchestrator.js';
import { getKey, returnKey, isPoolExhausted } from '../../src/redis/keyPool.js';
import { generateContent } from '../../src/services/gemini.js';
import { getBestModel } from '../../src/redis/modelHealth.js';

describe('maskKey()', () => {
  it('should mask a normal key', () => {
    const masked = maskKey('AIzaSyA1234567890abcdef');
    expect(masked).toMatch(/^AIza.*….*$/);
    expect(masked.length).toBeLessThan('AIzaSyA1234567890abcdef'.length);
  });

  it('should return **** for short keys', () => {
    expect(maskKey('abc')).toBe('****');
    expect(maskKey('')).toBe('****');
    expect(maskKey(null)).toBe('****');
  });
});

describe('runGenerate()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getKey.mockResolvedValue('test-api-key-12345678');
    isPoolExhausted.mockResolvedValue(false);
    getBestModel.mockImplementation((candidates) => Promise.resolve(candidates[0]));
  });

  it('should return text on successful generation', async () => {
    generateContent.mockResolvedValue({
      status: 200,
      data: { candidates: [{ content: { parts: [{ text: 'Hello world' }] } }], usageMetadata: {} },
      latencyMs: 100,
    });

    const result = await runGenerate({ prompt: 'Hi', model: 'model-a' });
    expect(result.text).toBe('Hello world');
    expect(result.model).toBe('model-a');
    expect(result.request_id).toBeDefined();
  });

  it('should return NO_KEYS when no api keys available', async () => {
    getKey.mockResolvedValue(null);
    const result = await runGenerate({ prompt: 'Hi', model: 'model-a' });
    expect(result.code).toBe('NO_KEYS');
    expect(result.httpStatus).toBe(503);
  });

  it('should return POOL_EXHAUSTED when pool is empty', async () => {
    getKey.mockResolvedValueOnce('key1');
    generateContent.mockResolvedValueOnce({ status: 429 });
    isPoolExhausted.mockResolvedValue(true);

    const result = await runGenerate({ prompt: 'Hi', model: 'model-a' });
    expect(result.code).toMatch(/POOL_EXHAUSTED|NO_KEYS/);
  });

  it('should handle timeout and fall back to next model', async () => {
    const timeoutErr = new Error('timeout');
    timeoutErr.code = 'TIMEOUT';
    generateContent
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce({
        status: 200,
        data: { candidates: [{ content: { parts: [{ text: 'Fallback worked' }] } }] },
        latencyMs: 200,
      });

    const result = await runGenerate({ prompt: 'Hi', model: 'model-a' });
    expect(result.text).toBe('Fallback worked');
    expect(result.retries).toBeGreaterThan(0);
  });

  it('should return RETRIES_EXHAUSTED when all retries fail', async () => {
    generateContent.mockResolvedValue({ status: 503 });
    getBestModel.mockResolvedValue(null);
    
    const result = await runGenerate({ prompt: 'Hi', model: 'model-a' });
    expect(result.code).toBe('RETRIES_EXHAUSTED');
  });
});
