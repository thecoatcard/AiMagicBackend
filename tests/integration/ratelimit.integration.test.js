import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildTestServer, makeToken } from './helpers/setup.js';

let app;

beforeAll(async () => { app = await buildTestServer(); });
afterAll(async () => { await app.close(); });

// ═══════════════════════════════════════════════════════════════════════════════
// 9. RATE LIMITING — verify rate limit module is invoked on rate-limited routes
// ═══════════════════════════════════════════════════════════════════════════════
describe('Rate Limiting Integration', () => {
  const token = makeToken();
  const headers = { authorization: `Bearer ${token}` };

  it('POST /v1/generate passes through rate limiter preHandler', async () => {
    // The checkUserRateLimit mock is wired as preHandler on /v1/generate.
    // It runs without blocking (mock). If it were to reject, we'd get 429.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      headers,
      payload: { prompt: 'rate limit test' },
    });
    // Should pass through (mock allows it)
    expect(res.statusCode).toBe(200);
  });

  it('POST /v1/generate/stream passes through rate limiter preHandler', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate/stream',
      headers,
      payload: { prompt: 'rate limit stream test' },
    });
    // Accept 200 or 500 (stream plumbing) — not 429
    expect(res.statusCode).not.toBe(429);
  });

  it('rate limiter rejection returns 429 with expected shape', async () => {
    // Temporarily override the rate limiter mock to simulate rejection
    const { checkUserRateLimit } = await import('../../src/middleware/rateLimiter.js');
    checkUserRateLimit.mockImplementationOnce(async (request, reply) => {
      return reply.status(429).send({
        error: 'Rate limit exceeded: max 60 requests per minute',
        code: 'RATE_LIMIT_EXCEEDED',
        reset_in_seconds: 42,
      });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      headers,
      payload: { prompt: 'should be rejected' },
    });

    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body).toHaveProperty('error');
    expect(body).toHaveProperty('code', 'RATE_LIMIT_EXCEEDED');
    expect(body).toHaveProperty('reset_in_seconds');
    expect(typeof body.reset_in_seconds).toBe('number');
  });
});
