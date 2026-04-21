import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRedis } from '../helpers/mocks.js';

const mockRedis = createMockRedis();
vi.mock('../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));

import { recordSuccess, recordFailure, getModelStats, listAllModels, getBestModel, resetModelStats } from '../../src/redis/modelHealth.js';

describe('recordSuccess()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.pipeline.mockReturnValue({
      hincrby: vi.fn().mockReturnThis(),
      hset: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    });
  });

  it('should call pipeline to record success', async () => {
    await recordSuccess('model-a', 150);
    expect(mockRedis.pipeline).toHaveBeenCalled();
  });
});

describe('recordFailure()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.pipeline.mockReturnValue({
      hincrby: vi.fn().mockReturnThis(),
      hset: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    });
  });

  it('should record 503 failure', async () => {
    await recordFailure('model-a', '503');
    expect(mockRedis.pipeline).toHaveBeenCalled();
  });

  it('should record timeout failure', async () => {
    await recordFailure('model-a', 'timeout');
    expect(mockRedis.pipeline).toHaveBeenCalled();
  });
});

describe('getModelStats()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return stats for a model', async () => {
    mockRedis.hgetall.mockResolvedValue({
      success: '10', fail_503: '2', fail_timeout: '1', fail_other: '0', total_latency_ms: '1500',
    });
    const stats = await getModelStats('model-a');
    expect(stats.model).toBe('model-a');
    expect(stats.success).toBe(10);
    expect(stats.success_rate).toBeCloseTo(10 / 13, 3);
  });

  it('should return null rates when no data', async () => {
    mockRedis.hgetall.mockResolvedValue({});
    const stats = await getModelStats('model-b');
    expect(stats.success_rate).toBeNull();
    expect(stats.avg_latency_ms).toBeNull();
  });
});

describe('getBestModel()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.pipeline.mockReturnValue({
      hgetall: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        [null, { success: '10', fail_503: '0', fail_timeout: '0', fail_other: '0' }],
        [null, { success: '5', fail_503: '5', fail_timeout: '0', fail_other: '0' }],
      ]),
    });
  });

  it('should return best model based on health score', async () => {
    const best = await getBestModel(['model-a', 'model-b']);
    expect(best).toBe('model-a'); // model-a has 100% success vs model-b 50%
  });

  it('should return the only candidate', async () => {
    const best = await getBestModel(['model-a']);
    expect(best).toBe('model-a');
  });

  it('should return null for empty candidates', async () => {
    const best = await getBestModel([]);
    expect(best).toBeNull();
  });
});

describe('resetModelStats()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should delete the model health key', async () => {
    await resetModelStats('model-a');
    expect(mockRedis.del).toHaveBeenCalled();
  });
});
