import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const cols = {};
  const mkCol = () => ({
    findOne: vi.fn(), find: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
    insertOne: vi.fn().mockResolvedValue({}), updateOne: vi.fn().mockResolvedValue({}),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  });
  return { mockDb: { collection: vi.fn((n) => { if (!cols[n]) cols[n] = mkCol(); return cols[n]; }) } };
});
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
}));

import { upsertApiKey, removeApiKey, getAllApiKeys } from '../../src/db/apiKeys.js';

describe('upsertApiKey()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should upsert key with status', async () => {
    mockDb.collection('api_keys').updateOne.mockResolvedValue({});
    await upsertApiKey('test-key', { status: 'active' });
    expect(mockDb.collection('api_keys').updateOne).toHaveBeenCalled();
  });
});

describe('removeApiKey()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should delete the key', async () => {
    mockDb.collection('api_keys').deleteOne.mockResolvedValue({ deletedCount: 1 });
    await removeApiKey('test-key');
    expect(mockDb.collection('api_keys').deleteOne).toHaveBeenCalledWith({ key: 'test-key' });
  });
});

describe('getAllApiKeys()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return all keys', async () => {
    const mockFind = { toArray: vi.fn().mockResolvedValue([{ key: 'k1' }, { key: 'k2' }]) };
    mockDb.collection('api_keys').find.mockReturnValue(mockFind);
    const keys = await getAllApiKeys();
    expect(keys).toHaveLength(2);
  });
});
