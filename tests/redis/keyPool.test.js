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
}));

import {
  getKey, returnKey, cooldownKey, disableKey, enableKey,
  addKey, removeKey, listKeys, isPoolExhausted,
  getPoolStats, clearAllCooldowns, restoreExpiredKeys,
} from '../../src/redis/keyPool.js';

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
