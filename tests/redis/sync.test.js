import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ioredis', () => {
  return {
    default: vi.fn().mockImplementation(function() {
      this.on = vi.fn();
      this.quit = vi.fn().mockResolvedValue('OK');
      this.ping = vi.fn().mockResolvedValue('PONG');
    }),
  };
});

vi.mock('../../src/redis/systemConfig.js', () => ({
  loadSystemConfigFromDb: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../src/redis/modelConfig.js', () => ({
  loadModelConfigFromDb: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../src/redis/keyPool.js', () => ({
  syncApiKeysWithDb: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/config.js', () => ({
  config: { redisUrls: ['redis://localhost:6379', 'redis://localhost:6380'] },
}));

import { warmupRedis, syncAllBackups } from '../../src/redis/sync.js';
import { loadSystemConfigFromDb } from '../../src/redis/systemConfig.js';
import { loadModelConfigFromDb } from '../../src/redis/modelConfig.js';

describe('warmupRedis()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should load config from DB to temp client', async () => {
    await warmupRedis('redis://localhost:6379');
    expect(loadSystemConfigFromDb).toHaveBeenCalled();
    expect(loadModelConfigFromDb).toHaveBeenCalled();
  });

  it('should skip when url is empty', async () => {
    await warmupRedis('');
    expect(loadSystemConfigFromDb).not.toHaveBeenCalled();
  });
});

describe('syncAllBackups()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should warm up all configured Redis instances', async () => {
    await syncAllBackups();
    // Called for each URL
    expect(loadSystemConfigFromDb).toHaveBeenCalledTimes(2);
  });
});
