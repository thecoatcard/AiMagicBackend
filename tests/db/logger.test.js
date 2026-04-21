import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const cols = {};
  const mkCol = () => ({ insertOne: vi.fn().mockResolvedValue({}) });
  return { mockDb: { collection: vi.fn((n) => { if (!cols[n]) cols[n] = mkCol(); return cols[n]; }) } };
});
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
}));

import { logRequest, logError } from '../../src/db/logger.js';

describe('logRequest()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should not throw (fire-and-forget)', () => {
    expect(() => logRequest({
      request_id: 'req1',
      model: 'model-a',
      api_key_masked: 'AIza…****',
      latency_ms: 100,
      status: 'success',
      retries: 0,
      prompt_length: 10,
    })).not.toThrow();
  });
});

describe('logError()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should not throw (fire-and-forget)', () => {
    expect(() => logError({
      type: '429',
      model: 'model-a',
      key_masked: 'AIza…****',
    })).not.toThrow();
  });
});
