import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer } from './helpers/setup.js';

let app;

beforeAll(async () => { app = await buildTestServer(); });
afterAll(async () => { await app.close(); });

// ═══════════════════════════════════════════════════════════════════════════════
// 7. HEALTH ENDPOINT — response shape
// ═══════════════════════════════════════════════════════════════════════════════
describe('Health Integration', () => {

  describe('GET /health', () => {
    it('should return { status: "ok" } without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /health/deep', () => {
    it('should return { status, redis } without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/deep' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('redis');
      expect(['ok', 'degraded']).toContain(body.status);
    });
  });
});
