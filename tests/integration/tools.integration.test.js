import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, makeToken } from './helpers/setup.js';

let app;

beforeAll(async () => { app = await buildTestServer(); });
afterAll(async () => { await app.close(); });

// ═══════════════════════════════════════════════════════════════════════════════
// 6. TOOLS — list and single tool response shapes
// ═══════════════════════════════════════════════════════════════════════════════
describe('Tools Integration', () => {
  const token = makeToken();
  const headers = { authorization: `Bearer ${token}` };

  describe('GET /v1/tools', () => {
    it('should return array of tools', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/tools', headers });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      if (body.length > 0) {
        const tool = body[0];
        expect(tool).toHaveProperty('id');
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('is_active');
        expect(tool).toHaveProperty('downloads');
      }
    });

    it('should accept query params: limit, skip, tag', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tools?limit=10&skip=0&tag=ai',
        headers,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /v1/tools/:id', () => {
    it('should return a single tool object', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tools/tool-1',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('description');
      expect(body).toHaveProperty('type');
      expect(body).toHaveProperty('is_active');
    });
  });
});
