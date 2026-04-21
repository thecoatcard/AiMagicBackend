import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRedis } from '../helpers/mocks.js';

const mockRedis = createMockRedis();

const mockDb = vi.hoisted(() => ({
  collection: vi.fn(() => ({
    updateOne: vi.fn().mockResolvedValue({}),
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
  })),
}));

vi.mock('../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));
vi.mock('../../src/db/client.js', () => ({ getDb: vi.fn().mockResolvedValue(mockDb) }));
vi.mock('../../src/redis/modelHealth.js', () => ({
  listAllModels: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/redis/keyPool.js', () => ({
  getAllKeyStats: vi.fn().mockResolvedValue({}),
}));

import { saveSnapshotToMongo, clearVolatileRedisData, runDailyRotation } from '../../src/services/dailySnapshot.js';

describe('saveSnapshotToMongo()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.scan.mockResolvedValue(['0', []]);
  });

  it('should upsert a snapshot document', async () => {
    const result = await saveSnapshotToMongo();
    expect(result).toHaveProperty('date');
    expect(result).toHaveProperty('models');
    expect(result).toHaveProperty('keys');
    expect(result).toHaveProperty('users');
    expect(mockDb.collection).toHaveBeenCalledWith('daily_snapshots');
  });
});

describe('clearVolatileRedisData()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.scan.mockResolvedValue(['0', []]);
    mockRedis.unlink.mockResolvedValue(1);
  });

  it('should clear volatile redis keys', async () => {
    const result = await clearVolatileRedisData();
    expect(result).toHaveProperty('deleted');
    expect(mockRedis.unlink).toHaveBeenCalled();
  });
});

describe('runDailyRotation()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.scan.mockResolvedValue(['0', []]);
    mockRedis.unlink.mockResolvedValue(1);
  });

  it('should return snapshot and cleared data', async () => {
    const result = await runDailyRotation();
    expect(result).toHaveProperty('snapshot');
    expect(result).toHaveProperty('cleared');
  });
});
