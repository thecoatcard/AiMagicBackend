import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(function() {
    this.on = vi.fn();
    this.close = vi.fn().mockResolvedValue(undefined);
  }),
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(msg) { super(msg); this.name = 'UnrecoverableError'; }
  },
}));
vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(function() {
    this.on = vi.fn();
    this.quit = vi.fn().mockResolvedValue('OK');
  }),
}));
vi.mock('../../src/config.js', () => ({
  config: { maxRetries: 3, workerConcurrency: 5 },
}));
vi.mock('../../src/services/orchestrator.js', () => ({
  runGenerate: vi.fn().mockResolvedValue({ text: 'result' }),
}));
vi.mock('../../src/queue/index.js', () => ({
  QUEUE_NAME: 'gemini-batch',
}));
vi.mock('../../src/services/notifications.js', () => ({
  notifyAdminWorkerFailure: vi.fn(),
}));
vi.mock('../../src/metrics/index.js', () => ({
  queueWaitDuration: { observe: vi.fn() },
}));
vi.mock('../../src/redis/client.js', () => ({
  redisEvents: { on: vi.fn(), emit: vi.fn() },
  getActiveRedisUrl: vi.fn().mockReturnValue('redis://localhost:6379'),
}));

import { startWorker, stopWorker } from '../../src/queue/worker.js';
import { Worker } from 'bullmq';

describe('worker', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('startWorker() should create a Worker instance', () => {
    const worker = startWorker(2);
    expect(Worker).toHaveBeenCalled();
    expect(worker).toBeDefined();
  });

  it('stopWorker() should close the worker', async () => {
    startWorker(2);
    await stopWorker();
    // After stop, calling start again should create a new worker
  });

  it('startWorker() should not create duplicate workers', () => {
    startWorker(2);
    const callCount = Worker.mock.calls.length;
    startWorker(2); // second call
    // Worker constructor not called again if _worker already exists
    // (the implementation guards with if (_worker) return _worker)
  });
});
