import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockReply, createMockRequest, createMockRedis } from '../helpers/mocks.js';

// Mock dependencies before importing module under test
const mockRedis = createMockRedis();
vi.mock('../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));
vi.mock('../../src/config.js', () => ({
  config: {
    jwtSecret: 'test-secret-key',
    jwtExpiresIn: '7d',
    ownerEmail: 'owner@test.com',
  },
}));
vi.mock('../../src/db/users.js', () => ({
  getUser: vi.fn(),
}));
vi.mock('../../src/redis/systemConfig.js', () => ({
  getMaxSessionsUser: vi.fn().mockResolvedValue(1),
  getMaxSessionsAdmin: vi.fn().mockResolvedValue(3),
}));

import jwt from 'jsonwebtoken';
import { authenticate } from '../../src/auth/middleware.js';
import { getUser } from '../../src/db/users.js';

const SECRET = 'test-secret-key';

describe('authenticate()', () => {
  let request, reply;

  beforeEach(() => {
    vi.clearAllMocks();
    request = createMockRequest();
    reply = createMockReply();
    getUser.mockResolvedValue({ email: 'user@test.com', role: 'user', status: 'active' });
    mockRedis.zscore.mockResolvedValue('12345');
  });

  it('should return 401 when no Authorization header', async () => {
    await authenticate(request, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply._body.code).toBe('UNAUTHORIZED');
  });

  it('should return 401 for invalid token', async () => {
    request.headers['authorization'] = 'Bearer invalid-token';
    await authenticate(request, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply._body.error).toBe('invalid_token');
  });

  it('should return 401 for expired token', async () => {
    const token = jwt.sign({ email: 'user@test.com', sessionId: 'sess1' }, SECRET, { expiresIn: '-1s' });
    request.headers['authorization'] = `Bearer ${token}`;
    await authenticate(request, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply._body.error).toBe('token_expired');
  });

  it('should set request.user on valid token with active session', async () => {
    const token = jwt.sign({ email: 'user@test.com', sessionId: 'sess1', role: 'user' }, SECRET, { expiresIn: '1h' });
    request.headers['authorization'] = `Bearer ${token}`;
    await authenticate(request, reply);
    expect(request.user).toBeDefined();
    expect(request.user.email).toBe('user@test.com');
    expect(request.user.role).toBe('user');
  });

  it('should return 401 when session is invalidated in Redis', async () => {
    mockRedis.zscore.mockResolvedValue(null);
    const token = jwt.sign({ email: 'user@test.com', sessionId: 'sess1', role: 'user' }, SECRET, { expiresIn: '1h' });
    request.headers['authorization'] = `Bearer ${token}`;
    await authenticate(request, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
  });

  it('should return 403 when user is blocked', async () => {
    getUser.mockResolvedValue({ email: 'user@test.com', role: 'user', status: 'blocked' });
    const token = jwt.sign({ email: 'user@test.com', sessionId: 'sess1', role: 'user' }, SECRET, { expiresIn: '1h' });
    request.headers['authorization'] = `Bearer ${token}`;
    await authenticate(request, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply._body.code).toBe('ACCOUNT_BLOCKED');
  });

  it('should override role to owner for ownerEmail', async () => {
    getUser.mockResolvedValue({ email: 'owner@test.com', role: 'user', status: 'active' });
    const token = jwt.sign({ email: 'owner@test.com', sessionId: 'sess1', role: 'user' }, SECRET, { expiresIn: '1h' });
    request.headers['authorization'] = `Bearer ${token}`;
    await authenticate(request, reply);
    expect(request.user.role).toBe('owner');
  });

  it('should handle impersonation tokens (read-only)', async () => {
    const token = jwt.sign({ email: 'user@test.com', role: 'user', impersonated: true, impersonator: 'admin@test.com' }, SECRET, { expiresIn: '1h' });
    request.headers['authorization'] = `Bearer ${token}`;
    request.method = 'GET';
    await authenticate(request, reply);
    expect(request.user.impersonated).toBe(true);
    expect(request.user.impersonator).toBe('admin@test.com');
  });

  it('should block mutating methods on impersonated tokens', async () => {
    const token = jwt.sign({ email: 'user@test.com', role: 'user', impersonated: true, impersonator: 'admin@test.com' }, SECRET, { expiresIn: '1h' });
    request.headers['authorization'] = `Bearer ${token}`;
    request.method = 'POST';
    await authenticate(request, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply._body.code).toBe('IMPERSONATION_READ_ONLY');
  });

  it('should accept token from query parameter', async () => {
    const token = jwt.sign({ email: 'user@test.com', sessionId: 'sess1', role: 'user' }, SECRET, { expiresIn: '1h' });
    request.query = { token };
    await authenticate(request, reply);
    expect(request.user).toBeDefined();
    expect(request.user.email).toBe('user@test.com');
  });
});
