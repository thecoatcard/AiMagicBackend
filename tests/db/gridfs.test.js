import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  return { mockDb: { collection: vi.fn() } };
});
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
}));
vi.mock('mongodb', () => ({
  GridFSBucket: vi.fn().mockImplementation(function() {
    this.openUploadStream = vi.fn();
    this.openDownloadStream = vi.fn();
    this.delete = vi.fn();
  }),
}));

import { getToolsBucket } from '../../src/db/gridfs.js';

describe('getToolsBucket()', () => {
  it('should return a bucket instance', async () => {
    const bucket = await getToolsBucket();
    expect(bucket).toBeDefined();
  });
});
