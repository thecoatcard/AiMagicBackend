import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, makeToken, makeExpiredToken, makeAdminToken, makeOwnerToken } from './helpers/setup.js';

let app;

beforeAll(async () => { app = await buildTestServer(); });
afterAll(async () => { await app.close(); });

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PROTECTED ROUTES — JWT requirement, expiry, blocked accounts
// ═══════════════════════════════════════════════════════════════════════════════
describe('Protected Routes Integration', () => {

  const protectedEndpoints = [
    { method: 'GET',  url: '/v1/users/me' },
    { method: 'GET',  url: '/v1/tools' },
    { method: 'GET',  url: '/v1/logs' },
    { method: 'GET',  url: '/v1/usage' },
  ];

  describe('requests without Authorization header return 401', () => {
    for (const { method, url } of protectedEndpoints) {
      it(`${method} ${url} → 401`, async () => {
        const res = await app.inject({ method, url });
        expect(res.statusCode).toBe(401);
        const body = res.json();
        expect(body).toHaveProperty('error');
        expect(body).toHaveProperty('code', 'UNAUTHORIZED');
      });
    }
  });

  describe('requests with valid JWT return 200', () => {
    for (const { method, url } of protectedEndpoints) {
      it(`${method} ${url} → 200`, async () => {
        const token = makeToken();
        const res = await app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
      });
    }
  });

  it('should return 401 for expired JWT', async () => {
    const token = makeExpiredToken();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body).toHaveProperty('code', 'UNAUTHORIZED');
  });

  it('should return 401 for malformed token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: 'Bearer not.a.valid.jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('should return 401 for missing Bearer prefix', async () => {
    const token = makeToken();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: token },
    });
    expect(res.statusCode).toBe(401);
  });

  it('should return 403 for blocked user', async () => {
    const token = makeToken({ email: 'blocked@test.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body).toHaveProperty('code', 'ACCOUNT_BLOCKED');
  });
});
