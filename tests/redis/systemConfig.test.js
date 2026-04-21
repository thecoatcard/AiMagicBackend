import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRedis } from '../helpers/mocks.js';

const mockRedis = createMockRedis();
vi.mock('../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));
vi.mock('../../src/config/plans.js', () => ({
  PLANS: { free: { daily_requests: 5 }, premium: { daily_requests: 500 } },
  getDailyLimit: vi.fn((plan) => plan === 'premium' ? 500 : 5),
}));
vi.mock('../../src/db/config.js', () => ({
  savePersistentConfig: vi.fn().mockResolvedValue(undefined),
  getPersistentConfig: vi.fn().mockResolvedValue(null),
}));

import {
  getSystemConfig, getAllSystemConfig, setSystemConfig,
  isMaintenanceMode, isGenerationEnabled, isRegistrationEnabled,
  getDefaultPerMin, getMaxSessionsUser, getMaxSessionsAdmin,
  getPlanDailyLimit, recordFailureRateTick, getFailureRateCount,
} from '../../src/redis/systemConfig.js';

describe('getSystemConfig()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return value from Redis', async () => {
    mockRedis.hget.mockResolvedValue('1');
    expect(await getSystemConfig('maintenance_mode')).toBe('1');
  });

  it('should return default when Redis has no value', async () => {
    mockRedis.hget.mockResolvedValue(null);
    expect(await getSystemConfig('maintenance_mode')).toBe('0');
  });
});

describe('getAllSystemConfig()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should merge defaults with stored values', async () => {
    mockRedis.hgetall.mockResolvedValue({ maintenance_mode: '1' });
    const config = await getAllSystemConfig();
    expect(config.maintenance_mode).toBe('1');
    expect(config.generation_enabled).toBe('1'); // default
  });
});

describe('setSystemConfig()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should set values in Redis', async () => {
    mockRedis.hset.mockResolvedValue(1);
    mockRedis.hgetall.mockResolvedValue({});
    await setSystemConfig({ maintenance_mode: '1' });
    expect(mockRedis.hset).toHaveBeenCalled();
  });
});

describe('isMaintenanceMode()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return true when value is 1', async () => {
    mockRedis.hget.mockResolvedValue('1');
    expect(await isMaintenanceMode()).toBe(true);
  });

  it('should return false when value is 0', async () => {
    mockRedis.hget.mockResolvedValue('0');
    expect(await isMaintenanceMode()).toBe(false);
  });
});

describe('isGenerationEnabled()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return true when enabled', async () => {
    mockRedis.hget.mockResolvedValue('1');
    expect(await isGenerationEnabled()).toBe(true);
  });
});

describe('isRegistrationEnabled()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return false when disabled', async () => {
    mockRedis.hget.mockResolvedValue('0');
    expect(await isRegistrationEnabled()).toBe(false);
  });
});

describe('getDefaultPerMin()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return parsed integer', async () => {
    mockRedis.hget.mockResolvedValue('120');
    expect(await getDefaultPerMin()).toBe(120);
  });

  it('should return 60 as fallback', async () => {
    mockRedis.hget.mockResolvedValue(null);
    expect(await getDefaultPerMin()).toBe(60);
  });
});

describe('getMaxSessionsUser()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return default of 1', async () => {
    mockRedis.hget.mockResolvedValue(null);
    expect(await getMaxSessionsUser()).toBe(1);
  });
});

describe('getMaxSessionsAdmin()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return default of 3', async () => {
    mockRedis.hget.mockResolvedValue(null);
    expect(await getMaxSessionsAdmin()).toBe(3);
  });
});

describe('recordFailureRateTick()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should increment bucket and set expiry', async () => {
    await recordFailureRateTick();
    expect(mockRedis.incr).toHaveBeenCalled();
    expect(mockRedis.expire).toHaveBeenCalled();
  });
});

describe('getFailureRateCount()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should sum counts across buckets', async () => {
    mockRedis.mget.mockResolvedValue(['3', '5', null, '2', '1']);
    const count = await getFailureRateCount(5);
    expect(count).toBe(11);
  });

  it('should return 0 for empty buckets', async () => {
    mockRedis.mget.mockResolvedValue([null, null]);
    expect(await getFailureRateCount(2)).toBe(0);
  });
});
