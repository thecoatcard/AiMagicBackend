/**
 * Wall-clock deadline behaviour tests.
 *
 * These tests verify that runGenerate/runEmbed honour maxRetryWallMs and
 * return DEADLINE_EXCEEDED without calling the upstream API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  maxRetries: 5,
  maxRetryWallMs: 60_000,
  requestTimeoutMs: 30_000,
  cooldownMs: 5_000,
  hivemindEmbeddingModel: 'gemini-embedding-2-preview',
}));
vi.mock('../../src/config.js', () => ({ config: mockConfig }));

vi.mock('../../src/redis/keyPool.js', () => ({
  getKey:            vi.fn().mockResolvedValue('test-key-1234'),
  returnKey:         vi.fn().mockResolvedValue(undefined),
  cooldownKey:       vi.fn().mockResolvedValue(undefined),
  disableKey:        vi.fn().mockResolvedValue(undefined),
  recordKeySuccess:  vi.fn().mockResolvedValue(undefined),
  recordKeyFailure:  vi.fn().mockResolvedValue(undefined),
  isPoolExhausted:   vi.fn().mockResolvedValue(false),
  classifyKeyFailure: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/services/gemini.js', () => ({
  generateContent:    vi.fn(),
  embedContent:       vi.fn(),
  batchEmbedContents: vi.fn(),
  generateImage:      vi.fn(),
}));

vi.mock('../../src/redis/modelHealth.js', () => ({
  recordSuccess: vi.fn().mockResolvedValue(undefined),
  recordFailure: vi.fn().mockResolvedValue(undefined),
  getBestModel:  vi.fn().mockImplementation(candidates => Promise.resolve(candidates?.[0] ?? null)),
}));

vi.mock('../../src/redis/modelConfig.js', () => ({
  getActiveFallbackModels: vi.fn().mockResolvedValue(['gemini-2.5-flash']),
  getImageModels:          vi.fn().mockResolvedValue(['gemini-2.5-flash-image']),
}));

vi.mock('../../src/db/logger.js', () => ({
  logRequest: vi.fn(),
  logError:   vi.fn(),
}));

vi.mock('../../src/services/notifications.js', () => ({
  notifyAdminNoKeys: vi.fn(),
}));

vi.mock('../../src/redis/systemConfig.js', () => ({
  recordFailureRateTick:     vi.fn().mockResolvedValue(undefined),
  isHivemindRuntimeEnabled:  vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/services/hivemind.js', () => ({
  isHivemindEnabled:  vi.fn().mockReturnValue(false),
  retrieveContext:    vi.fn().mockResolvedValue([]),
  storeContext:       vi.fn().mockResolvedValue(undefined),
  buildContextPrefix: vi.fn().mockReturnValue(''),
}));

vi.mock('../../src/redis/client.js', () => ({
  getRedis: vi.fn().mockReturnValue({ set: vi.fn().mockResolvedValue('OK') }),
}));

vi.mock('../../src/metrics/index.js', () => ({
  requestsTotal:       { inc: vi.fn() },
  requestDuration:     { observe: vi.fn() },
  retriesTotal:        { inc: vi.fn() },
  keyCooldownsTotal:   { inc: vi.fn() },
  model503Total:       { inc: vi.fn() },
  modelTimeoutsTotal:  { inc: vi.fn() },
  hivemindEmbeddingsTotal: { inc: vi.fn() },
}));

import { runGenerate, runEmbed } from '../../src/services/orchestrator.js';
import { generateContent, embedContent } from '../../src/services/gemini.js';

describe('Wall-clock deadline — runGenerate()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns DEADLINE_EXCEEDED without calling generateContent when deadline is already past', async () => {
    mockConfig.maxRetryWallMs = -1; // deadline is instantly in the past

    const result = await runGenerate({ prompt: 'hello', model: 'gemini-2.5-flash' });

    expect(result.code).toBe('DEADLINE_EXCEEDED');
    expect(result.httpStatus).toBe(503);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('includes an error message for DEADLINE_EXCEEDED', async () => {
    mockConfig.maxRetryWallMs = -1;

    const result = await runGenerate({ prompt: 'hello', model: 'gemini-2.5-flash' });

    expect(result.error).toBeTruthy();
    expect(typeof result.error).toBe('string');
  });

  it('succeeds normally when deadline is generous', async () => {
    mockConfig.maxRetryWallMs = 60_000;
    generateContent.mockResolvedValue({
      status: 200,
      data: { candidates: [{ content: { parts: [{ text: 'pong' }] } }] },
      latencyMs: 10,
    });

    const result = await runGenerate({ prompt: 'ping', model: 'gemini-2.5-flash' });

    expect(result.code).toBeUndefined();
    expect(result.text).toBe('pong');
  });

  it('effectiveTimeoutMs is capped to remaining budget', async () => {
    // Set a tight budget so the first attempt's effectiveTimeoutMs < requestTimeoutMs
    mockConfig.maxRetryWallMs = 5_000;
    mockConfig.requestTimeoutMs = 30_000;

    generateContent.mockResolvedValue({
      status: 200,
      data: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] },
      latencyMs: 5,
    });

    await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });

    // The 5th argument to generateContent is effectiveTimeoutMs
    const calledTimeoutMs = generateContent.mock.calls[0][4];
    // It must be ≤ maxRetryWallMs (5000) and ≥ 1000 (minimum)
    expect(calledTimeoutMs).toBeGreaterThanOrEqual(1000);
    expect(calledTimeoutMs).toBeLessThanOrEqual(5_000);
  });
});

describe('Wall-clock deadline — runEmbed()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns DEADLINE_EXCEEDED without calling embedContent when deadline is already past', async () => {
    mockConfig.maxRetryWallMs = -1;

    const result = await runEmbed({ text: 'embed me' });

    expect(result.code).toBe('DEADLINE_EXCEEDED');
    expect(result.httpStatus).toBe(503);
    expect(embedContent).not.toHaveBeenCalled();
  });
});
