import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, makeToken, makeAdminToken, makeOwnerToken } from './helpers/setup.js';

let app;

beforeAll(async () => { app = await buildTestServer(); });
afterAll(async () => { await app.close(); });

// ═══════════════════════════════════════════════════════════════════════════════
// 10. ERROR RESPONSE SHAPES — consistent { error, code } format
// ═══════════════════════════════════════════════════════════════════════════════
describe('Error Response Shapes Integration', () => {

  describe('401 Unauthorized errors', () => {
    it('should return { error, code: "UNAUTHORIZED" }', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/users/me' });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code', 'UNAUTHORIZED');
      expect(typeof body.error).toBe('string');
    });
  });

  describe('403 Forbidden errors', () => {
    it('should return { error, code: "FORBIDDEN" } for admin routes', async () => {
      const userToken = makeToken({ email: 'user@test.com', role: 'user' });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/users',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code', 'FORBIDDEN');
    });

    it('should return { error, code: "ACCOUNT_BLOCKED" } for blocked users', async () => {
      const blockedToken = makeToken({ email: 'blocked@test.com' });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/users/me',
        headers: { authorization: `Bearer ${blockedToken}` },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body).toHaveProperty('code', 'ACCOUNT_BLOCKED');
    });
  });

  describe('400 Bad Request errors', () => {
    it('POST /auth/login with missing email → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      // Fastify schema validation error shape
      expect(body).toHaveProperty('message');
    });

    it('POST /v1/generate with no content → 400 { error, code: "BAD_REQUEST" }', async () => {
      const token = makeToken();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/generate',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code', 'BAD_REQUEST');
    });
  });

  describe('404 Not Found errors', () => {
    it('GET /v1/tools/:id with nonexistent id → 404', async () => {
      // Override getTool mock to return null for this specific ID
      const { getTool } = await import('../../src/db/tools.js');
      getTool.mockResolvedValueOnce(null);

      const token = makeToken();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tools/nonexistent',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body).toHaveProperty('error');
    });

    it('GET /v1/users/:email with nonexistent user → 404 (admin)', async () => {
      const { getUser } = await import('../../src/db/users.js');
      getUser.mockResolvedValueOnce(null) // first call from middleware — returns null (fail open)
             .mockResolvedValueOnce(null); // second call from route handler
      // Use owner token since admin is blocked by owner check on the user email endpoint...
      // Actually the /v1/users/:email uses requireAdmin, let's use admin
      const adminToken = makeAdminToken();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/users/notfound@test.com',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body).toHaveProperty('error');
    });
  });

  describe('OTP errors have consistent shape', () => {
    it('POST /auth/verify with wrong OTP → { error, code: "OTP_INVALID" }', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        payload: { email: 'user@test.com', otp: '000000' },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code', 'OTP_INVALID');
    });
  });
});
