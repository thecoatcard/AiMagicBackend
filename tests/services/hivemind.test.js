import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock ioredis ─────────────────────────────────────────────────────────────
const mockSet = vi.fn().mockResolvedValue('OK');
const mockScan = vi.fn().mockResolvedValue(['0', []]);
const mockMget = vi.fn().mockResolvedValue([]);
const mockQuit = vi.fn().mockResolvedValue('OK');
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();

vi.mock('ioredis', () => {
  return {
    default: vi.fn().mockImplementation(function () {
      this.set = mockSet;
      this.scan = mockScan;
      this.mget = mockMget;
      this.quit = mockQuit;
      this.connect = mockConnect;
      this.on = mockOn;
    }),
  };
});

vi.mock('../../src/config.js', () => ({
  config: {
    hivemindRedisUrl: 'redis://localhost:6380',
    hivemindTtlSecs: 14400,
    hivemindTopK: 3,
    hivemindEmbeddingModel: 'gemini-embedding-2-preview',
    hivemindMaxSnippetLen: 500,
  },
}));

// Import after mocks
const { isHivemindEnabled, storeContext, retrieveContext, buildContextPrefix, shutdownHivemind } = await import('../../src/services/hivemind.js');

describe('hivemind service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isHivemindEnabled()', () => {
    it('should return true when HIVEMIND_REDIS_URL is set', () => {
      expect(isHivemindEnabled()).toBe(true);
    });
  });

  describe('storeContext()', () => {
    it('should store a vector entry with TTL in Redis', async () => {
      const vector = [0.1, 0.2, 0.3, 0.4];
      await storeContext('user@test.com', 'hello world', vector);

      expect(mockSet).toHaveBeenCalledTimes(1);
      const [key, payload, ex, ttl] = mockSet.mock.calls[0];
      expect(key).toMatch(/^hm:user@test\.com:/);
      expect(ex).toBe('EX');
      expect(ttl).toBe(14400);

      const parsed = JSON.parse(payload);
      expect(parsed.t).toBe('hello world');
      expect(parsed.v).toEqual([0.1, 0.2, 0.3, 0.4]);
      expect(parsed.ts).toBeGreaterThan(0);
    });

    it('should truncate long snippets', async () => {
      const longText = 'a'.repeat(1000);
      await storeContext('user@test.com', longText, [0.1]);

      const payload = JSON.parse(mockSet.mock.calls[0][1]);
      expect(payload.t.length).toBeLessThanOrEqual(501); // 500 + '…'
      expect(payload.t.endsWith('…')).toBe(true);
    });
  });

  describe('retrieveContext()', () => {
    it('should return empty array when no entries exist', async () => {
      mockScan.mockResolvedValueOnce(['0', []]);
      const result = await retrieveContext('user@test.com', [0.1, 0.2]);
      expect(result).toEqual([]);
    });

    it('should return top-K snippets sorted by cosine similarity', async () => {
      // Simulate 3 stored entries
      mockScan.mockResolvedValueOnce(['0', ['hm:user@test.com:a', 'hm:user@test.com:b', 'hm:user@test.com:c']]);
      mockMget.mockResolvedValueOnce([
        JSON.stringify({ t: 'highly relevant', v: [1, 0, 0], ts: Date.now() }),
        JSON.stringify({ t: 'somewhat relevant', v: [0.7, 0.7, 0], ts: Date.now() }),
        JSON.stringify({ t: 'not relevant', v: [0, 0, 1], ts: Date.now() }),
      ]);

      const queryVector = [1, 0, 0]; // Most similar to first entry
      const result = await retrieveContext('user@test.com', queryVector);

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toBe('highly relevant');
    });

    it('should filter out low-similarity results (< 0.3)', async () => {
      mockScan.mockResolvedValueOnce(['0', ['hm:user@test.com:a']]);
      mockMget.mockResolvedValueOnce([
        JSON.stringify({ t: 'orthogonal', v: [0, 1, 0], ts: Date.now() }),
      ]);

      const queryVector = [1, 0, 0]; // Orthogonal = cosine 0
      const result = await retrieveContext('user@test.com', queryVector);
      expect(result).toEqual([]);
    });

    it('should skip corrupt JSON entries gracefully', async () => {
      mockScan.mockResolvedValueOnce(['0', ['hm:user@test.com:a', 'hm:user@test.com:b']]);
      mockMget.mockResolvedValueOnce([
        'not valid json',
        JSON.stringify({ t: 'valid entry', v: [1, 0], ts: Date.now() }),
      ]);

      const result = await retrieveContext('user@test.com', [1, 0]);
      expect(result.length).toBe(1);
      expect(result[0]).toBe('valid entry');
    });

    it('should handle Redis errors gracefully', async () => {
      mockScan.mockRejectedValueOnce(new Error('Redis down'));
      const result = await retrieveContext('user@test.com', [0.1]);
      expect(result).toEqual([]);
    });
  });

  describe('buildContextPrefix()', () => {
    it('should return null for empty snippets', () => {
      expect(buildContextPrefix([])).toBeNull();
      expect(buildContextPrefix(null)).toBeNull();
    });

    it('should build a numbered context string', () => {
      const result = buildContextPrefix(['snippet one', 'snippet two']);
      expect(result).toContain('[1] snippet one');
      expect(result).toContain('[2] snippet two');
      expect(result).toContain('Relevant prior context');
    });
  });

  describe('shutdownHivemind()', () => {
    it('should quit the Redis client', async () => {
      await shutdownHivemind();
      expect(mockQuit).toHaveBeenCalled();
    });
  });
});
