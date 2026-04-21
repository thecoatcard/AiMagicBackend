import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, makeToken, makeAdminToken, makeOwnerToken } from './helpers/setup.js';

let app;

beforeAll(async () => { app = await buildTestServer(); });
afterAll(async () => { await app.close(); });

// ═══════════════════════════════════════════════════════════════════════════════
// 8. ADMIN ROUTES — role-based access control
// ═══════════════════════════════════════════════════════════════════════════════
describe('Admin Routes Integration', () => {
  const userToken = makeToken({ email: 'user@test.com', role: 'user' });
  const adminToken = makeAdminToken();
  const ownerToken = makeOwnerToken();

  // ── Admin-only routes (requireAdmin) ────────────────────────────────────────
  const adminRoutes = [
    { method: 'GET', url: '/v1/users', desc: 'list users' },
    { method: 'GET', url: '/v1/users/stats', desc: 'user stats' },
    { method: 'GET', url: '/v1/tickets/stats', desc: 'ticket stats' },
  ];

  describe('admin-only routes reject regular users with 403', () => {
    for (const { method, url, desc } of adminRoutes) {
      it(`${method} ${url} (${desc}) → 403 for user role`, async () => {
        const res = await app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${userToken}` },
        });
        expect(res.statusCode).toBe(403);
        const body = res.json();
        expect(body).toHaveProperty('error');
        expect(body).toHaveProperty('code', 'FORBIDDEN');
      });
    }
  });

  describe('admin-only routes accept admin role with 200', () => {
    for (const { method, url, desc } of adminRoutes) {
      it(`${method} ${url} (${desc}) → 200 for admin role`, async () => {
        const res = await app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(res.statusCode).toBe(200);
      });
    }
  });

  // ── Owner-only routes (requireOwner) ──────────────────────────────────────
  const ownerRoutes = [
    { method: 'GET', url: '/v1/keys', desc: 'list keys' },
    { method: 'GET', url: '/v1/models', desc: 'model health' },
    { method: 'GET', url: '/v1/models/config', desc: 'model config' },
    { method: 'GET', url: '/v1/errors', desc: 'error logs' },
    { method: 'GET', url: '/v1/analytics/time-series', desc: 'time series' },
  ];

  describe('owner-only routes reject admin with 403', () => {
    for (const { method, url, desc } of ownerRoutes) {
      it(`${method} ${url} (${desc}) → 403 for admin role`, async () => {
        const res = await app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(res.statusCode).toBe(403);
      });
    }
  });

  describe('owner-only routes accept owner with 200', () => {
    for (const { method, url, desc } of ownerRoutes) {
      it(`${method} ${url} (${desc}) → 200 for owner role`, async () => {
        const res = await app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${ownerToken}` },
        });
        expect(res.statusCode).toBe(200);
      });
    }
  });

  describe('owner-only routes reject regular users with 403', () => {
    for (const { method, url, desc } of ownerRoutes) {
      it(`${method} ${url} (${desc}) → 403 for user role`, async () => {
        const res = await app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${userToken}` },
        });
        expect(res.statusCode).toBe(403);
      });
    }
  });
});
