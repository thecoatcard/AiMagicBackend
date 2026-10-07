import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRedis } from '../helpers/mocks.js';

const mockRedis = createMockRedis();
vi.mock('../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));

import {
  recordSuccess,
  recordFailure,
  getModelStats,
  listAllModels,
  getBestModel,
  resetModelStats,
  invalidateBestModelCache,
} from '../../src/redis/modelHealth.js';

// BUCKET_WINDOW = 4, so pipeline results per model = 1 lifetime + 4 buckets = 5
const SLOTS = 5;

function makePipelineResults(...models) {
  // models: array of { lifetime, buckets[] } objects
  return models.flatMap(({ lifetime = null, buckets = [] }) => {
    const rows = [[null, lifetime]];
    for (let i = 0; i < 4; i++) {
      rows.push([null, buckets[i] ?? null]);
    }
    return rows;
  });
}

describe('recordSuccess()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.multi.mockReturnValue({
      hincrby: vi.fn().mockReturnThis(),
      hset: vi.fn().mockReturnThis(),
      expireat: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    });
  });

  it('calls multi twice (lifetime + bucket)', async () => {
    await recordSuccess('model-a', 150);
    expect(mockRedis.multi).toHaveBeenCalledTimes(2);
  });
});

describe('recordFailure()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.multi.mockReturnValue({
      hincrby: vi.fn().mockReturnThis(),
      hset: vi.fn().mockReturnThis(),
      expireat: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    });
  });

  it('calls multi twice for 503 failure', async () => {
    await recordFailure('model-a', '503');
    expect(mockRedis.multi).toHaveBeenCalledTimes(2);
  });

  it('calls multi twice for timeout failure', async () => {
    await recordFailure('model-a', 'timeout');
    expect(mockRedis.multi).toHaveBeenCalledTimes(2);
  });

  it('calls multi twice for other failure', async () => {
    await recordFailure('model-a', 'other');
    expect(mockRedis.multi).toHaveBeenCalledTimes(2);
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
    invalidateBestModelCache();
  });

  it('returns the only candidate immediately', async () => {
    const best = await getBestModel(['model-a']);
    expect(best).toBe('model-a');
  });

  it('returns null for empty candidates', async () => {
    const best = await getBestModel([]);
    expect(best).toBeNull();
  });

  it('uses lifetime stats when no recent bucket data', async () => {
    // model-a: 10 success / 10 total lifetime; no recent buckets
    // model-b: 5 success / 10 total lifetime; no recent buckets
    mockRedis.pipeline.mockReturnValue({
      hgetall: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(makePipelineResults(
        { lifetime: { success: '10', fail_503: '0', fail_timeout: '0', fail_other: '0' } },
        { lifetime: { success: '5', fail_503: '5', fail_timeout: '0', fail_other: '0' } },
      )),
    });
    const best = await getBestModel(['model-a', 'model-b']);
    expect(best).toBe('model-a');
  });

  it('uses windowed bucket stats when recent total >= 3', async () => {
    // model-a: bucket has 1 success / 10 total (terrible recent perf)
    // model-b: bucket has 9 success / 10 total (great recent perf)
    // Lifetime for both is good, but windowed should override for model-b
    mockRedis.pipeline.mockReturnValue({
      hgetall: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(makePipelineResults(
        {
          lifetime: { success: '50', fail_503: '0', fail_timeout: '0', fail_other: '0' },
          buckets: [{ success: '1', fail_503: '9', fail_timeout: '0', fail_other: '0' }],
        },
        {
          lifetime: { success: '2', fail_503: '8', fail_timeout: '0', fail_other: '0' },
          buckets: [{ success: '9', fail_503: '1', fail_timeout: '0', fail_other: '0' }],
        },
      )),
    });
    const best = await getBestModel(['model-a', 'model-b']);
    // model-b recent: 9/10 = great; model-a recent: 1/10 = terrible
    expect(best).toBe('model-b');
  });

  it('falls back to lifetime when recent bucket total < 3', async () => {
    // model-a: 1 recent sample (< 3) → falls back to great lifetime
    // model-b: 1 recent sample (< 3) → falls back to terrible lifetime
    mockRedis.pipeline.mockReturnValue({
      hgetall: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(makePipelineResults(
        {
          lifetime: { success: '50', fail_503: '0', fail_timeout: '0', fail_other: '0' },
          buckets: [{ success: '1', fail_503: '0', fail_timeout: '0', fail_other: '0' }],
        },
        {
          lifetime: { success: '1', fail_503: '49', fail_timeout: '0', fail_other: '0' },
          buckets: [{ success: '0', fail_503: '1', fail_timeout: '0', fail_other: '0' }],
        },
      )),
    });
    const best = await getBestModel(['model-a', 'model-b']);
    expect(best).toBe('model-a');
  });

  it('aggregates multiple recent buckets', async () => {
    // model-b has 3 successful recent buckets spread across bucket slots
    mockRedis.pipeline.mockReturnValue({
      hgetall: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(makePipelineResults(
        {
          lifetime: { success: '10', fail_503: '0', fail_timeout: '0', fail_other: '0' },
          buckets: [
            { success: '0', fail_503: '3', fail_timeout: '0', fail_other: '0' },
            { success: '0', fail_503: '3', fail_timeout: '0', fail_other: '0' },
          ],
        },
        {
          lifetime: { success: '0', fail_503: '10', fail_timeout: '0', fail_other: '0' },
          buckets: [
            { success: '3', fail_503: '0', fail_timeout: '0', fail_other: '0' },
            { success: '3', fail_503: '0', fail_timeout: '0', fail_other: '0' },
          ],
        },
      )),
    });
    const best = await getBestModel(['model-a', 'model-b']);
    // model-a recent: 0 success / 6 = bad; model-b recent: 6 success / 6 = great
    expect(best).toBe('model-b');
  });

  it('caches result and avoids second pipeline call', async () => {
    invalidateBestModelCache();
    const pipelineMock = {
      hgetall: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(makePipelineResults(
        { lifetime: { success: '5', fail_503: '0', fail_timeout: '0', fail_other: '0' } },
        { lifetime: { success: '3', fail_503: '0', fail_timeout: '0', fail_other: '0' } },
      )),
    };
    mockRedis.pipeline.mockReturnValue(pipelineMock);
    await getBestModel(['model-x', 'model-y']);
    await getBestModel(['model-x', 'model-y']);
    expect(pipelineMock.exec).toHaveBeenCalledTimes(1);
  });
});

describe('resetModelStats()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should delete the lifetime model health key', async () => {
    await resetModelStats('model-a');
    expect(mockRedis.del).toHaveBeenCalledWith('model_health:model-a');
  });
});
