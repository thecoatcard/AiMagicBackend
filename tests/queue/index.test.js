import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function() {
    this.add = vi.fn().mockResolvedValue({ id: 'job-1' });
    this.close = vi.fn().mockResolvedValue(undefined);
  }),
}));
vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(function() {
    this.on = vi.fn();
    this.quit = vi.fn().mockResolvedValue('OK');
  }),
}));
vi.mock('../../src/config.js', () => ({
  config: { maxRetries: 3 },
}));
vi.mock('../../src/redis/client.js', () => ({
  redisEvents: { on: vi.fn(), emit: vi.fn() },
  getActiveRedisUrl: vi.fn().mockReturnValue('redis://localhost:6379'),
}));

import { getQueue, closeQueue, QUEUE_NAME } from '../../src/queue/index.js';

describe('queue/index', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should export correct QUEUE_NAME', () => {
    expect(QUEUE_NAME).toBe('gemini-batch');
  });

  it('getQueue() should return a queue instance', () => {
    const queue = getQueue();
    expect(queue).toBeDefined();
    expect(queue.add).toBeDefined();
  });

  it('closeQueue() should close the queue', async () => {
    getQueue(); // ensure queue exists
    await closeQueue();
    // After close, calling getQueue creates a new one
  });
});
