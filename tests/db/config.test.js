import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const cols = {};
  const mkCol = () => ({ findOne: vi.fn(), updateOne: vi.fn().mockResolvedValue({}) });
  return { mockDb: { collection: vi.fn((n) => { if (!cols[n]) cols[n] = mkCol(); return cols[n]; }) } };
});
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
}));

import { savePersistentConfig, getPersistentConfig } from '../../src/db/config.js';

describe('savePersistentConfig()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should upsert config document', async () => {
    mockDb.collection('config').updateOne.mockResolvedValue({});
    await savePersistentConfig('system', { maintenance_mode: '0' });
    expect(mockDb.collection('config').updateOne).toHaveBeenCalled();
  });
});

describe('getPersistentConfig()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return config document', async () => {
    mockDb.collection('config').findOne.mockResolvedValue({ _id: 'system', maintenance_mode: '0' });
    const result = await getPersistentConfig('system');
    expect(result._id).toBe('system');
  });

  it('should return null when not found', async () => {
    mockDb.collection('config').findOne.mockResolvedValue(null);
    const result = await getPersistentConfig('nonexistent');
    expect(result).toBeNull();
  });
});
