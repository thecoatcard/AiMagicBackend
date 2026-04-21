import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, makeToken } from './helpers/setup.js';

let app;

beforeAll(async () => { app = await buildTestServer(); });
afterAll(async () => { await app.close(); });

// ═══════════════════════════════════════════════════════════════════════════════
// 4. USER PROFILE — GET /v1/users/me response shape
// ═══════════════════════════════════════════════════════════════════════════════
describe('User Profile Integration', () => {
  const token = makeToken();
  const headers = { authorization: `Bearer ${token}` };

  describe('GET /v1/users/me', () => {
    it('should return user document with expected shape', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/users/me', headers });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Frontend User type fields
      expect(body).toHaveProperty('email');
      expect(body).toHaveProperty('role');
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('plan');
      expect(typeof body.email).toBe('string');
      expect(['user', 'admin', 'owner']).toContain(body.role);
      expect(['active', 'blocked']).toContain(body.status);
      expect(['free', 'premium']).toContain(body.plan);
    });

    it('should return the authenticated user email', async () => {
      const token = makeToken({ email: 'specific@test.com' });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/users/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.email).toBe('specific@test.com');
    });
  });
});
