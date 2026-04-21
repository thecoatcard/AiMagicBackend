import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRedis } from '../helpers/mocks.js';

const mockRedis = createMockRedis();
vi.mock('../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));

import { healthRoutes } from '../../src/routes/health.js';

describe('healthRoutes', () => {
  let fastify;

  beforeEach(() => {
    vi.clearAllMocks();
    fastify = {
      get: vi.fn(),
      post: vi.fn(),
    };
    healthRoutes(fastify);
  });

  it('should register GET /health route', () => {
    expect(fastify.get).toHaveBeenCalledWith('/health', expect.any(Function));
  });

  it('should register GET /health/deep route', () => {
    expect(fastify.get).toHaveBeenCalledWith('/health/deep', expect.any(Function));
  });

  it('/health handler should return ok', async () => {
    const handler = fastify.get.mock.calls[0][1];
    const result = await handler();
    expect(result).toEqual({ status: 'ok' });
  });

  it('/health/deep should return ok when Redis is up', async () => {
    const handler = fastify.get.mock.calls[1][1];
    mockRedis.ping.mockResolvedValue('PONG');
    const reply = { status: vi.fn().mockReturnThis() };
    const result = await handler({}, reply);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(result.status).toBe('ok');
  });

  it('/health/deep should return degraded when Redis is down', async () => {
    const handler = fastify.get.mock.calls[1][1];
    mockRedis.ping.mockRejectedValue(new Error('connection refused'));
    const reply = { status: vi.fn().mockReturnThis() };
    const result = await handler({}, reply);
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(result.status).toBe('degraded');
  });
});
