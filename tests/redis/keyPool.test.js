import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRedis } from '../helpers/mocks.js';

const mockRedis = createMockRedis();
vi.mock('../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));
vi.mock('../../src/config.js', () => ({
  config: { geminiKeys: ['key1', 'key2'] },
}));
vi.mock('../../src/services/notifications.js', () => ({
  notifyAdminKeyPoolLow: vi.fn(),
}));
vi.mock('../../src/db/apiKeys.js', () => ({
  upsertApiKey: vi.fn().mockResolvedValue(undefined),
  removeApiKey: vi.fn().mockResolvedValue(undefined),
  getAllApiKeys: vi.fn().mockResolvedValue([]),
  getApiKey: vi.fn().mockResolvedValue(null),
}));

import {
  getKey, returnKey, cooldownKey, disableKey, enableKey,
  addKey, removeKey, listKeys, isPoolExhausted,
  getPoolStats, clearAllCooldowns, restoreExpiredKeys,
  classifyKeyFailure, categorizeTestResult,
} from '../../src/redis/keyPool.js';

describe('key inventory security', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('removes a masked credential from both stores using its raw key', async () => {
    mockRedis.hget.mockResolvedValue('raw-key-123456789');
    expect(await removeKey('raw-…abcdef…6789')).toEqual({ removed: true });
    expect(mockRedis.lrem).toHaveBeenCalledWith('gemini_keys', 0, 'raw-key-123456789');
    const { removeApiKey } = await import('../../src/db/apiKeys.js');
    expect(removeApiKey).toHaveBeenCalledWith('raw-key-123456789');
  });

  it('does not delete unknown masked credentials', async () => {
    mockRedis.hget.mockResolvedValue(null);
    expect(await removeKey('raw-…missing…6789')).toEqual({ removed: false });
    expect(mockRedis.lrem).not.toHaveBeenCalled();
  });

  it('refuses to re-enable compromised credentials', async () => {
    const { getApiKey } = await import('../../src/db/apiKeys.js');
    getApiKey.mockResolvedValueOnce({ key: 'leaked-key-123456', last_reason: 'key_leaked' });
    await expect(enableKey('leaked-key-123456')).rejects.toMatchObject({ statusCode: 409, code: 'KEY_QUARANTINED' });
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it('keeps a compromised verdict when a weaker failure follows', async () => {
    const { getApiKey, upsertApiKey } = await import('../../src/db/apiKeys.js');
    getApiKey.mockResolvedValueOnce({ key: 'leaked-key-123456', last_reason: 'key_leaked' });
    mockRedis.eval.mockResolvedValue(1);
    await disableKey('leaked-key-123456', 'admin');
    expect(upsertApiKey).toHaveBeenCalledWith('leaked-key-123456', { status: 'disabled', reason: 'key_leaked' });
  });

  it('restores only expired cooldowns when the active pool is low', async () => {
    mockRedis.llen.mockResolvedValue(1);
    mockRedis.eval.mockResolvedValue(0);
    await cooldownKey('rate-limited-key-123456', 60000, '429_rate_limit');
    await Promise.resolve();
    const recovery = mockRedis.eval.mock.calls.find(call => call[0].includes('ZRANGEBYSCORE'));
    expect(Number(recovery.at(-1))).toBeLessThanOrEqual(Date.now());
  });

  it('distinguishes compromised keys from model permission errors', () => {
    expect(classifyKeyFailure({ status: 403, data: { error: { message: 'Your API key was reported as leaked' } } })).toBe('key_leaked');
    expect(classifyKeyFailure({ status: 400, data: { error: { message: 'API key revoked' } } })).toBe('key_revoked');
    expect(classifyKeyFailure({ status: 403, data: { error: { message: 'Consumer has been suspended' } } })).toBe('key_revoked');
    expect(classifyKeyFailure({ status: 400, data: { error: { message: 'API key not valid. Please pass a valid API key.' } } })).toBe('key_invalid');
    expect(classifyKeyFailure({ status: 403, data: { error: { message: 'Blocked', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } } })).toBe('key_restricted');
    expect(classifyKeyFailure({ status: 403, data: { error: { message: 'Requests from referer <empty> are blocked.' } } })).toBe('key_restricted');
    expect(classifyKeyFailure({ status: 404, data: { error: { message: 'models/x is not found' } } })).toBeNull();
    expect(classifyKeyFailure({ status: 503 })).toBeNull();
  });

  it('categorizes test outcomes', () => {
    expect(categorizeTestResult(200, null)).toBe('healthy');
    expect(categorizeTestResult(403, 'key_restricted')).toBe('restricted');
    expect(categorizeTestResult(429, null)).toBe('rate_limited');
    expect(categorizeTestResult(503, null)).toBe('inconclusive');
  });

  it('lists leaked and revoked keys without exposing raw credentials', async () => {
    const { getAllApiKeys } = await import('../../src/db/apiKeys.js');
    getAllApiKeys.mockResolvedValueOnce([
      { key: 'leaked-key-123456', last_reason: 'key_leaked' },
      { key: 'revoked-key-123456', last_reason: 'key_revoked', last_test: { ok: false, status: 400, reason: 'key_revoked', latency_ms: 50, model: 'm', at: new Date() } },
      { key: 'restricted-key-123456', last_reason: 'key_restricted' },
    ]);
    mockRedis.lrange.mockResolvedValue([]);
    mockRedis.zrangebyscore.mockResolvedValue(['leaked-key-123456', '253402300799000', 'revoked-key-123456', '253402300799000', 'restricted-key-123456', '253402300799000']);
    mockRedis.hgetall.mockResolvedValue({});
    const result = await listKeys();
    expect(result.cooldown.map(key => key.status)).toEqual(['leaked', 'revoked', 'restricted']);
    expect(result.cooldown[1].lastTest).toMatchObject({ category: 'revoked', latency_ms: 50 });
    expect(JSON.stringify(result)).not.toContain('leaked-key-123456');
  });
});

describe('getKey()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should rpop from active list', async () => {
    mockRedis.rpop.mockResolvedValue('api-key-1');
    const key = await getKey();
    expect(key).toBe('api-key-1');
    expect(mockRedis.rpop).toHaveBeenCalled();
  });

  it('should return null when no keys available', async () => {
    mockRedis.rpop.mockResolvedValue(null);
    expect(await getKey()).toBeNull();
  });
});

describe('returnKey()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should eval lua script to return key', async () => {
    mockRedis.eval.mockResolvedValue(1);
    await returnKey('api-key-1');
    expect(mockRedis.eval).toHaveBeenCalled();
  });
});

describe('isPoolExhausted()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return true when no active and no near-expiry keys', async () => {
    mockRedis.llen.mockResolvedValue(0);
    mockRedis.zrangebyscore.mockResolvedValue([]);
    expect(await isPoolExhausted()).toBe(true);
  });

  it('should return false when active keys exist', async () => {
    mockRedis.llen.mockResolvedValue(5);
    expect(await isPoolExhausted()).toBe(false);
  });
});

describe('addKey()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should add key when not present', async () => {
    mockRedis.eval.mockResolvedValue(0);
    mockRedis.hset.mockResolvedValue(1);
    const result = await addKey('new-key');
    expect(result.added).toBe(true);
  });

  it('should return already_active when key exists in pool', async () => {
    mockRedis.eval.mockResolvedValue(1);
    const result = await addKey('existing-key');
    expect(result.added).toBe(false);
    expect(result.reason).toBe('already_active');
  });

  it('should return in_cooldown when key is cooling down', async () => {
    mockRedis.eval.mockResolvedValue(2);
    const result = await addKey('cooldown-key');
    expect(result.added).toBe(false);
    expect(result.reason).toBe('in_cooldown');
  });
});

describe('getPoolStats()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return active, cooldown, disabled counts', async () => {
    mockRedis.llen.mockResolvedValue(10);
    mockRedis.zcount.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    const stats = await getPoolStats();
    expect(stats.active).toBe(10);
    expect(stats.cooldown).toBe(3);
    expect(stats.disabled).toBe(1);
    expect(stats.total).toBe(14);
  });
});

describe('listKeys()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return active and cooldown keys', async () => {
    mockRedis.lrange.mockResolvedValue(['key1234567890']);
    mockRedis.zrangebyscore.mockResolvedValue([]);
    mockRedis.hgetall.mockResolvedValue({});
    const result = await listKeys();
    expect(result).toHaveProperty('active');
    expect(result).toHaveProperty('cooldown');
  });
});

describe('restoreExpiredKeys()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should eval lua to restore expired keys', async () => {
    mockRedis.eval.mockResolvedValue(2);
    await restoreExpiredKeys();
    expect(mockRedis.eval).toHaveBeenCalled();
  });
});

describe('clearAllCooldowns()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should eval lua to clear temporary cooldowns', async () => {
    mockRedis.eval.mockResolvedValue(3);
    const count = await clearAllCooldowns();
    expect(count).toBe(3);
  });
});
