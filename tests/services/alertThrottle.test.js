import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRedis } from '../helpers/mocks.js';

const mockRedis = createMockRedis();
vi.mock('../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));

import { shouldSendAlert, clearAlertThrottle } from '../../src/services/alertThrottle.js';

describe('shouldSendAlert()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true when alert key is new (SET NX returns OK)', async () => {
    mockRedis.set.mockResolvedValue('OK');
    const result = await shouldSendAlert('alert:test', 600);
    expect(result).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith('alert:test', '1', 'EX', 600, 'NX');
  });

  it('should return false when alert key already exists (SET NX returns null)', async () => {
    mockRedis.set.mockResolvedValue(null);
    const result = await shouldSendAlert('alert:test', 600);
    expect(result).toBe(false);
  });

  it('should return true on Redis error (fail open)', async () => {
    mockRedis.set.mockRejectedValue(new Error('connection lost'));
    const result = await shouldSendAlert('alert:test', 600);
    expect(result).toBe(true);
  });
});

describe('clearAlertThrottle()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delete the throttle key', async () => {
    await clearAlertThrottle('alert:test');
    expect(mockRedis.del).toHaveBeenCalledWith('alert:test');
  });

  it('should not throw on Redis error', async () => {
    mockRedis.del.mockRejectedValue(new Error('fail'));
    await expect(clearAlertThrottle('alert:test')).resolves.not.toThrow();
  });
});
