import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { buildTestServer, makeToken, makeAdminToken, makeOwnerToken } from './helpers/setup.js';
import { resolveRawKey, removeKey, disableKey } from '../../src/redis/keyPool.js';
import { generateContent } from '../../src/services/gemini.js';

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

  describe('credential test and deletion endpoints', () => {
    const masked = 'AIza…abcdef…6789';
    const auth = { authorization: `Bearer ${ownerToken}` };

    it('tests a stored masked key without returning the raw credential', async () => {
      vi.mocked(generateContent).mockResolvedValueOnce({ status: 200 });
      const res = await app.inject({ method: 'POST', url: `/v1/keys/${encodeURIComponent(masked)}/test`, headers: auth, payload: { model: 'test-model' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, model: 'test-model', status: 200 });
      expect(res.body).not.toContain('test-key-123456789');
    });

    it('quarantines leaked keys identified by a test', async () => {
      vi.mocked(generateContent).mockResolvedValueOnce({ status: 403, data: { error: { message: 'API key reported as leaked: test-key-123456789' } } });
      const res = await app.inject({ method: 'POST', url: `/v1/keys/${encodeURIComponent(masked)}/test`, headers: auth, payload: {} });
      expect(res.json()).toMatchObject({ ok: false, reason: 'key_leaked' });
      expect(disableKey).toHaveBeenCalledWith('test-key-123456789', 'key_leaked');
      expect(res.body).not.toContain('test-key-123456789');
    });

    it('returns 404 for an unknown masked key', async () => {
      vi.mocked(resolveRawKey).mockResolvedValueOnce(null);
      const res = await app.inject({ method: 'POST', url: `/v1/keys/${encodeURIComponent(masked)}/test`, headers: auth, payload: {} });
      expect(res.statusCode).toBe(404);
    });

    it('rejects model path injection', async () => {
      const res = await app.inject({ method: 'POST', url: `/v1/keys/${encodeURIComponent(masked)}/test`, headers: auth, payload: { model: '../invalid?key=secret' } });
      expect(res.statusCode).toBe(400);
    });

    it('deletes selected masked credentials and reports partial failures', async () => {
      vi.mocked(removeKey).mockResolvedValueOnce({ removed: true }).mockRejectedValueOnce(new Error('database unavailable'));
      const other = 'AIza…123456…7890';
      const res = await app.inject({ method: 'POST', url: '/v1/keys/bulk-delete', headers: auth, payload: { keys: [masked, other] } });
      expect(res.statusCode).toBe(200);
      expect(res.json().results).toEqual([{ key: masked, removed: true }, { key: other, removed: false, error: 'Deletion failed; retry this key' }]);
    });

    it('rejects empty, duplicate, oversized, and raw-key deletion requests', async () => {
      for (const keys of [[], [masked, masked], Array(101).fill(masked), ['raw-secret-key']]) {
        const res = await app.inject({ method: 'POST', url: '/v1/keys/bulk-delete', headers: auth, payload: { keys } });
        expect(res.statusCode).toBe(400);
      }
    });

    it('rejects non-owner and unauthenticated access to both operations', async () => {
      for (const token of [userToken, adminToken, null]) {
        for (const url of ['/v1/keys/bulk-delete', `/v1/keys/${encodeURIComponent(masked)}/test`]) {
          const res = await app.inject({ method: 'POST', url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: url.endsWith('/test') ? {} : { keys: [masked] } });
          expect(res.statusCode).toBe(token ? 403 : 401);
        }
      }
    });
  });

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
