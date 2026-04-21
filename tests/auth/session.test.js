import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRedis } from '../helpers/mocks.js';

const mockRedis = createMockRedis();
vi.mock('../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));
vi.mock('../../src/config.js', () => ({
  config: {
    jwtSecret: 'test-secret-key',
    jwtExpiresIn: '7d',
    otpTtlMs: 600000,
  },
}));
vi.mock('../../src/redis/systemConfig.js', () => ({
  getMaxSessionsUser: vi.fn().mockResolvedValue(1),
  getMaxSessionsAdmin: vi.fn().mockResolvedValue(3),
}));

import jwt from 'jsonwebtoken';
import { createSession, validateSession, invalidateSession } from '../../src/auth/session.js';

const SECRET = 'test-secret-key';

describe('createSession()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.eval.mockResolvedValue(0);
  });

  it('should return a token and wasSuperseded flag', async () => {
    const result = await createSession('user@test.com', 'user', 'free');
    expect(result).toHaveProperty('token');
    expect(result).toHaveProperty('wasSuperseded');
    expect(typeof result.token).toBe('string');
  });

  it('should create a valid JWT with expected payload', async () => {
    const result = await createSession('user@test.com', 'user', 'free');
    const decoded = jwt.verify(result.token, SECRET);
    expect(decoded.email).toBe('user@test.com');
    expect(decoded.role).toBe('user');
    expect(decoded.plan).toBe('free');
    expect(decoded.sessionId).toBeDefined();
  });

  it('should call Redis eval for atomic session creation', async () => {
    await createSession('user@test.com', 'user', 'free');
    expect(mockRedis.eval).toHaveBeenCalled();
  });

  it('should report wasSuperseded=true when old sessions removed', async () => {
    mockRedis.eval.mockResolvedValue(1);
    const result = await createSession('user@test.com', 'user', 'free');
    expect(result.wasSuperseded).toBe(true);
  });

  it('should report wasSuperseded=false when no sessions removed', async () => {
    mockRedis.eval.mockResolvedValue(0);
    const result = await createSession('user@test.com', 'user', 'free');
    expect(result.wasSuperseded).toBe(false);
  });
});

describe('validateSession()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return valid=true for a valid token with active session', async () => {
    const token = jwt.sign({ email: 'user@test.com', sessionId: 'sess1', role: 'user', plan: 'free' }, SECRET, { expiresIn: '1h' });
    mockRedis.zscore.mockResolvedValue('12345');
    const result = await validateSession(token);
    expect(result.valid).toBe(true);
    expect(result.email).toBe('user@test.com');
  });

  it('should return valid=false for expired token', async () => {
    const token = jwt.sign({ email: 'user@test.com', sessionId: 'sess1' }, SECRET, { expiresIn: '-1s' });
    const result = await validateSession(token);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('token_expired');
  });

  it('should return valid=false for invalid token', async () => {
    const result = await validateSession('garbage-token');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_token');
  });

  it('should return valid=false when session not in Redis', async () => {
    const token = jwt.sign({ email: 'user@test.com', sessionId: 'sess1', role: 'user' }, SECRET, { expiresIn: '1h' });
    mockRedis.zscore.mockResolvedValue(null);
    const result = await validateSession(token);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('session_invalid_or_superseded');
  });
});

describe('invalidateSession()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should remove specific session with zrem', async () => {
    await invalidateSession('user@test.com', 'sess1');
    expect(mockRedis.zrem).toHaveBeenCalled();
  });

  it('should remove all sessions with del when no sessionId', async () => {
    await invalidateSession('user@test.com');
    expect(mockRedis.del).toHaveBeenCalled();
  });
});
