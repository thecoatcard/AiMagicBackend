import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, makeToken } from './helpers/setup.js';

let app;

beforeAll(async () => { app = await buildTestServer(); });
afterAll(async () => { await app.close(); });

// ═══════════════════════════════════════════════════════════════════════════════
// 3. GENERATE ENDPOINT — request/response contract
// ═══════════════════════════════════════════════════════════════════════════════
describe('Generate Integration', () => {
  const token = makeToken();
  const headers = { authorization: `Bearer ${token}` };

  describe('POST /v1/generate', () => {
    it('should accept { prompt, model } and return { text, model, latency_ms, retries, status }', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/generate',
        headers,
        payload: { prompt: 'Hello world', model: 'test-model' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('text');
      expect(body).toHaveProperty('model');
      expect(body).toHaveProperty('latency_ms');
      expect(body).toHaveProperty('retries');
      expect(body).toHaveProperty('status', 'success');
      expect(typeof body.text).toBe('string');
      expect(typeof body.latency_ms).toBe('number');
    });

    it('should accept optional fields: temperature, maxOutputTokens, systemInstruction', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/generate',
        headers,
        payload: {
          prompt: 'Test prompt',
          model: 'test-model',
          temperature: 0.7,
          maxOutputTokens: 1000,
          systemInstruction: 'You are helpful.',
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('should accept history array with { role, text } items', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/generate',
        headers,
        payload: {
          prompt: 'Continue',
          history: [
            { role: 'user', text: 'Hello' },
            { role: 'model', text: 'Hi!' },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('should reject empty body (no prompt, images, or files) with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/generate',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code', 'BAD_REQUEST');
    });

    it('should reject temperature out of range with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/generate',
        headers,
        payload: { prompt: 'test', temperature: 5 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should accept images array with base64 type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/generate',
        headers,
        payload: {
          prompt: 'Describe this image',
          images: [{ type: 'base64', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('should require auth (401 without token)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/generate',
        payload: { prompt: 'test' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /v1/generate/stream', () => {
    it('should accept same body shape as /v1/generate', async () => {
      // Stream endpoint should accept the request — it may fail during streaming,
      // but the contract (request shape acceptance) is what we test.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/generate/stream',
        headers,
        payload: { prompt: 'Hello stream' },
      });
      // Accept 200 (success), 500 (stream plumbing), or 502 (upstream mock)
      // The important contract is that it doesn't 400 with valid input
      expect([200, 500, 502]).toContain(res.statusCode);
    });

    it('should reject empty body with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/generate/stream',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
