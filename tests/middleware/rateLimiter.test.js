import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRedis, createMockReply, createMockRequest } from '../helpers/mocks.js';

const mockRedis = createMockRedis();
vi.mock('../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));
vi.mock('../../src/db/users.js', () => ({
  getUser: vi.fn(),
  incrementUserUsage: vi.fn(),
}));
vi.mock('../../src/config/plans.js', () => ({
  PLANS: { free: { daily_requests: 5 }, premium: { daily_requests: 500 } },
  getDailyLimit: vi.fn((plan) => plan === 'premium' ? 500 : 5),
}));
vi.mock('../../src/services/notifications.js', () => ({
  notifyQuotaWarning: vi.fn(),
}));
vi.mock('../../src/redis/systemConfig.js', () => ({
  getDefaultPerMin: vi.fn().mockResolvedValue(60),
  getPlanDailyLimit: vi.fn().mockResolvedValue(5),
}));

import { checkUserRateLimit, checkBatchRateLimit, getDailyUsage } from '../../src/middleware/rateLimiter.js';
import { getUser, incrementUserUsage } from '../../src/db/users.js';

describe('checkUserRateLimit()', () => {
  let request, reply;

  beforeEach(() => {
    vi.clearAllMocks();
    request = createMockRequest({ user: { email: 'user@test.com', role: 'user' } });
    reply = createMockReply();
    getUser.mockResolvedValue({ email: 'user@test.com', plan: 'free', limits: {} });
    mockRedis.get.mockResolvedValue(null);
    mockRedis.eval.mockResolvedValue([1, 60]);
  });

  it('should bypass rate limit for admin users', async () => {
    request.user.role = 'admin';
    await checkUserRateLimit(request, reply);
    expect(reply.status).not.toHaveBeenCalled();
    expect(incrementUserUsage).toHaveBeenCalledWith('user@test.com');
  });

  it('should bypass rate limit for owner users', async () => {
    request.user.role = 'owner';
    await checkUserRateLimit(request, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('should allow request within rate limit', async () => {
    mockRedis.eval.mockResolvedValue([1, 60]);
    await checkUserRateLimit(request, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('should return 429 when per-minute limit exceeded', async () => {
    mockRedis.eval.mockResolvedValueOnce([-1, 45]);
    await checkUserRateLimit(request, reply);
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply._body.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('should return 429 when daily limit exceeded', async () => {
    mockRedis.eval
      .mockResolvedValueOnce([1, 60])   // per-minute OK
      .mockResolvedValueOnce([-1, 3600]); // daily exceeded
    await checkUserRateLimit(request, reply);
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply._body.code).toBe('DAILY_LIMIT_EXCEEDED');
  });
});

describe('checkBatchRateLimit()', () => {
  let request, reply;

  beforeEach(() => {
    vi.clearAllMocks();
    request = createMockRequest({
      user: { email: 'user@test.com', role: 'user' },
      body: { prompts: ['a', 'b', 'c'] },
    });
    reply = createMockReply();
    getUser.mockResolvedValue({ email: 'user@test.com', plan: 'free', limits: {} });
    mockRedis.get.mockResolvedValue(null);
    mockRedis.eval.mockResolvedValue([3, 60]);
  });

  it('should bypass for admin and count batch prompts', async () => {
    request.user.role = 'admin';
    await checkBatchRateLimit(request, reply);
    expect(incrementUserUsage).toHaveBeenCalledWith('user@test.com', 3);
  });

  it('should return 429 when batch exceeds per-minute limit', async () => {
    mockRedis.eval.mockResolvedValueOnce([-1, 30]);
    await checkBatchRateLimit(request, reply);
    expect(reply.status).toHaveBeenCalledWith(429);
  });
});

describe('getDailyUsage()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return usage count and reset time', async () => {
    mockRedis.get.mockResolvedValue('42');
    mockRedis.ttl.mockResolvedValue(3600);
    const result = await getDailyUsage('user@test.com');
    expect(result.used).toBe(42);
    expect(result.reset_in_seconds).toBe(3600);
  });

  it('should return 0 when no usage data', async () => {
    mockRedis.get.mockResolvedValue(null);
    mockRedis.ttl.mockResolvedValue(-1);
    const result = await getDailyUsage('user@test.com');
    expect(result.used).toBe(0);
    expect(result.reset_in_seconds).toBe(86400);
  });
});
