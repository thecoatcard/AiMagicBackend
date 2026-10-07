import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures this variable is accessible inside vi.mock factories
// (which are hoisted above top-level const declarations by vitest)
const mockPool = vi.hoisted(() => ({ instance: null }));

vi.mock('undici', () => ({
  Pool: vi.fn().mockImplementation(function() {
    mockPool.instance = this;
    this.request = vi.fn();
  }),
}));
vi.mock('../../src/config.js', () => ({
  config: { requestTimeoutMs: 30000 },
}));

import { Pool } from 'undici';
import { generateContent, embedContent, batchEmbedContents } from '../../src/services/gemini.js';

describe('gemini service — module initialisation', () => {
  it('constructs Pool with the correct base URL', () => {
    expect(Pool).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com',
      expect.any(Object)
    );
  });
});

describe('generateContent() — parseError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns data: null and parseError: true when upstream body is not JSON', async () => {
    mockPool.instance.request.mockResolvedValue({
      statusCode: 200,
      body: {
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
        dump: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await generateContent('key', 'model', 'hello');
    expect(result.data).toBeNull();
    expect(result.parseError).toBe(true);
    expect(result.status).toBe(200);
  });

  it('returns parsed data on valid JSON response', async () => {
    const payload = { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] };
    mockPool.instance.request.mockResolvedValue({
      statusCode: 200,
      body: {
        json: vi.fn().mockResolvedValue(payload),
        dump: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await generateContent('key', 'model', 'hello');
    expect(result.data).toEqual(payload);
    expect(result.parseError).toBeUndefined();
  });

  it('throws with code TIMEOUT on AbortError', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    mockPool.instance.request.mockRejectedValue(abortErr);

    await expect(generateContent('key', 'model', 'hello')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('passes custom timeoutMs — signal is an AbortSignal', async () => {
    mockPool.instance.request.mockResolvedValue({
      statusCode: 200,
      body: { json: vi.fn().mockResolvedValue({}), dump: vi.fn() },
    });

    await generateContent('key', 'model', 'hello', {}, 5000);
    const callArgs = mockPool.instance.request.mock.calls[0][0];
    expect(callArgs.signal).toBeTruthy();
    expect(typeof callArgs.signal.aborted).toBe('boolean');
  });
});

describe('embedContent() — parseError', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns data: null and parseError: true when upstream body is not JSON', async () => {
    mockPool.instance.request.mockResolvedValue({
      statusCode: 503,
      body: {
        json: vi.fn().mockRejectedValue(new SyntaxError('bad json')),
        dump: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await embedContent('key', 'embedding-model', 'text');
    expect(result.data).toBeNull();
    expect(result.parseError).toBe(true);
    expect(result.status).toBe(503);
  });
});

describe('batchEmbedContents() — parseError', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns data: null and parseError: true when upstream body is not JSON', async () => {
    mockPool.instance.request.mockResolvedValue({
      statusCode: 500,
      body: {
        json: vi.fn().mockRejectedValue(new SyntaxError('bad json')),
        dump: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await batchEmbedContents('key', 'embedding-model', ['a', 'b']);
    expect(result.data).toBeNull();
    expect(result.parseError).toBe(true);
  });
});
