/**
 * Response correctness tests.
 *
 * Covers: parseError propagation from gemini.js → orchestrator model switch,
 * and the empty-200-response (EMPTY_RESPONSE) detection path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  maxRetries: 4,
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
  getActiveFallbackModels: vi.fn().mockResolvedValue(['gemini-2.5-flash', 'gemini-2.5-flash-lite']),
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

import { runGenerate } from '../../src/services/orchestrator.js';
import { generateContent } from '../../src/services/gemini.js';
import { recordFailure } from '../../src/redis/modelHealth.js';

const okPayload = {
  candidates: [{ content: { parts: [{ text: 'response text' }] } }]
};

describe('parseError handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.maxRetryWallMs = 60_000;
    mockConfig.maxRetries = 4;
  });

  it('calls recordFailure when upstream returns non-JSON (parseError)', async () => {
    generateContent
      .mockResolvedValueOnce({ status: 200, data: null, parseError: true, latencyMs: 5 })
      .mockResolvedValue({ status: 200, data: okPayload, latencyMs: 20 });

    await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });

    expect(recordFailure).toHaveBeenCalledWith(expect.any(String), 'other');
  });

  it('retries on parseError and returns success from next attempt', async () => {
    generateContent
      .mockResolvedValueOnce({ status: 200, data: null, parseError: true, latencyMs: 5 })
      .mockResolvedValue({ status: 200, data: okPayload, latencyMs: 20 });

    const result = await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });

    expect(result.text).toBe('response text');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('returns RETRIES_EXHAUSTED if all attempts return parseError', async () => {
    generateContent.mockResolvedValue({ status: 200, data: null, parseError: true, latencyMs: 5 });

    const result = await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });

    // All fallback models exhausted
    expect(['RETRIES_EXHAUSTED', 'DEADLINE_EXCEEDED']).toContain(result.code);
    expect(result.httpStatus).toBe(503);
  });
});

describe('EMPTY_RESPONSE detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.maxRetryWallMs = 60_000;
    mockConfig.maxRetries = 4;
  });

  it('returns EMPTY_RESPONSE for 200 with empty parts array', async () => {
    generateContent.mockResolvedValue({
      status: 200,
      data: { candidates: [{ content: { parts: [] } }] },
      latencyMs: 10,
    });

    const result = await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });

    expect(result.code).toBe('EMPTY_RESPONSE');
    expect(result.httpStatus).toBe(502);
  });

  it('returns EMPTY_RESPONSE for 200 with only thought parts (filtered out)', async () => {
    generateContent.mockResolvedValue({
      status: 200,
      data: {
        candidates: [{
          content: { parts: [{ text: 'thinking...', thought: true }] }
        }]
      },
      latencyMs: 10,
    });

    const result = await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });

    expect(result.code).toBe('EMPTY_RESPONSE');
    expect(result.httpStatus).toBe(502);
  });

  it('succeeds when response contains function calls even with no text', async () => {
    generateContent.mockResolvedValue({
      status: 200,
      data: {
        candidates: [{
          content: {
            parts: [{
              functionCall: { name: 'get_weather', args: { city: 'NYC' } }
            }]
          }
        }]
      },
      latencyMs: 10,
    });

    const result = await runGenerate({ prompt: 'weather in NYC', model: 'gemini-2.5-flash' });

    expect(result.code).toBeUndefined();
    expect(result.functionCalls).toEqual([{ name: 'get_weather', args: { city: 'NYC' } }]);
  });

  it('succeeds when response contains audio (inlineData audio parts)', async () => {
    generateContent.mockResolvedValue({
      status: 200,
      data: {
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: 'audio/mp3', data: 'base64audiobytes' } }]
          }
        }]
      },
      latencyMs: 10,
    });

    const result = await runGenerate({ prompt: 'say hello', model: 'gemini-2.5-flash' });

    expect(result.code).toBeUndefined();
    expect(result.audio).toBe('base64audiobytes');
  });
});
