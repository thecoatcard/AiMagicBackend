import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mock every dependency ──────────────────────────────────────────────────

// vi.hoisted so this object is reachable inside vi.mock factory (which vitest
// hoists above top-level const declarations).
const mockConfig = vi.hoisted(() => ({
  maxRetries: 3,
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
  generateContent:      vi.fn(),
  embedContent:         vi.fn(),
  batchEmbedContents:   vi.fn(),
  generateImage:        vi.fn(),
}));

vi.mock('../../src/redis/modelHealth.js', () => ({
  recordSuccess: vi.fn().mockResolvedValue(undefined),
  recordFailure: vi.fn().mockResolvedValue(undefined),
  getBestModel:  vi.fn().mockImplementation(candidates => Promise.resolve(candidates[0] ?? null)),
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
  getRedis: vi.fn().mockReturnValue({
    set: vi.fn().mockResolvedValue('OK'),
  }),
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

import { runGenerate, maskKey } from '../../src/services/orchestrator.js';
import { generateContent } from '../../src/services/gemini.js';
import { getKey } from '../../src/redis/keyPool.js';

const successPayload = {
  candidates: [{
    content: { parts: [{ text: 'Hello world' }] }
  }]
};

describe('runGenerate() — success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.maxRetryWallMs = 60_000;
    generateContent.mockResolvedValue({ status: 200, data: successPayload, latencyMs: 50 });
  });

  it('returns text on 200 response', async () => {
    const result = await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });
    expect(result.error).toBeUndefined();
    expect(result.text).toBe('Hello world');
    expect(result.model).toBe('gemini-2.5-flash');
  });

  it('includes request_id and latency_ms', async () => {
    const result = await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });
    expect(result.request_id).toBeTruthy();
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('runGenerate() — wall-clock deadline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set deadline in the past so every attempt is rejected immediately
    mockConfig.maxRetryWallMs = -1;
  });

  it('returns DEADLINE_EXCEEDED code and 503 status', async () => {
    const result = await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });
    expect(result.code).toBe('DEADLINE_EXCEEDED');
    expect(result.httpStatus).toBe(503);
    // generateContent should never have been called
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe('runGenerate() — empty 200 response (EMPTY_RESPONSE)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.maxRetryWallMs = 60_000;
  });

  it('returns EMPTY_RESPONSE when candidates have no text, audio, or functionCalls', async () => {
    generateContent.mockResolvedValue({
      status: 200,
      data: { candidates: [{ content: { parts: [] } }] },
      latencyMs: 30,
    });
    const result = await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });
    expect(result.code).toBe('EMPTY_RESPONSE');
    expect(result.httpStatus).toBe(502);
  });

  it('returns EMPTY_RESPONSE when candidates is missing', async () => {
    generateContent.mockResolvedValue({
      status: 200,
      data: {},
      latencyMs: 30,
    });
    const result = await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });
    expect(result.code).toBe('EMPTY_RESPONSE');
    expect(result.httpStatus).toBe(502);
  });
});

describe('runGenerate() — parseError triggers model switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.maxRetryWallMs = 60_000;
    mockConfig.maxRetries = 3;
  });

  it('switches to fallback model after parseError, succeeds on second model', async () => {
    generateContent
      .mockResolvedValueOnce({ status: 200, data: null, parseError: true, latencyMs: 10 })
      .mockResolvedValue({ status: 200, data: successPayload, latencyMs: 50 });

    const result = await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });
    // Should succeed on retry
    expect(result.text).toBe('Hello world');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });
});

describe('runGenerate() — no keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.maxRetryWallMs = 60_000;
  });

  it('returns NO_KEYS when key pool is empty', async () => {
    getKey.mockResolvedValue(null);

    const result = await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });
    expect(result.code).toBe('NO_KEYS');
    expect(result.httpStatus).toBe(503);
  });
});

describe('runGenerate() — retries exhausted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.maxRetryWallMs = 60_000;
    mockConfig.maxRetries = 2;
    // Reset getKey in case a prior test set it to null
    getKey.mockResolvedValue('test-key-1234');
  });

  it('returns RETRIES_EXHAUSTED after all models fail with 503', async () => {
    generateContent.mockResolvedValue({ status: 503, data: { error: { message: 'unavailable' } }, latencyMs: 10 });
    const result = await runGenerate({ prompt: 'hi', model: 'gemini-2.5-flash' });
    expect(result.code).toBe('RETRIES_EXHAUSTED');
    expect(result.httpStatus).toBe(503);
  });
});

describe('maskKey()', () => {
  it('masks short keys', () => {
    expect(maskKey('1234')).toBe('****');
    expect(maskKey('')).toBe('****');
  });

  it('preserves first 4 and last 4 chars with hash in middle', () => {
    const masked = maskKey('AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456');
    expect(masked).toMatch(/^AIza…[0-9a-f]{6}…3456$/);
  });
});
