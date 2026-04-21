import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, makeToken, makeExpiredToken } from './helpers/setup.js';

let app;

beforeAll(async () => { app = await buildTestServer(); });
afterAll(async () => { await app.close(); });

// ═══════════════════════════════════════════════════════════════════════════════
// 1. AUTH FLOW — login, verify, logout, /auth/me
// ═══════════════════════════════════════════════════════════════════════════════
describe('Auth Integration', () => {

  // ── POST /auth/login ────────────────────────────────────────────────────────
  describe('POST /auth/login', () => {
    it('should accept { email } and return { message }', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'user@test.com' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('message');
      expect(body.message).toMatch(/OTP/i);
    });

    it('should reject missing email with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject invalid email format with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'not-an-email' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── POST /auth/verify ──────────────────────────────────────────────────────
  describe('POST /auth/verify', () => {
    it('should accept { email, otp } and return { token, message }', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        payload: { email: 'user@test.com', otp: '123456' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('message');
      expect(typeof body.token).toBe('string');
      expect(body.token.split('.')).toHaveLength(3); // JWT format: header.payload.signature
    });

    it('should reject invalid OTP with 401', async () => {
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

    it('should reject non-6-digit otp with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        payload: { email: 'user@test.com', otp: '12' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject missing fields with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        payload: { email: 'user@test.com' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── POST /auth/logout ──────────────────────────────────────────────────────
  describe('POST /auth/logout', () => {
    it('should return { message } with valid token', async () => {
      const token = makeToken();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('message');
      expect(body.message).toMatch(/logged out/i);
    });

    it('should reject without token with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── GET /auth/me ───────────────────────────────────────────────────────────
  describe('GET /auth/me', () => {
    it('should return { email, role } with valid token', async () => {
      const token = makeToken();
      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('email', 'user@test.com');
      expect(body).toHaveProperty('role');
    });
  });
});
