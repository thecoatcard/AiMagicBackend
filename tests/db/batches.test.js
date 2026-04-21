import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const cols = {};
  const mkCol = () => ({
    findOne: vi.fn(), insertOne: vi.fn().mockResolvedValue({}),
  });
  return { mockDb: { collection: vi.fn((n) => { if (!cols[n]) cols[n] = mkCol(); return cols[n]; }) } };
});
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
}));

import { createBatch, getBatch } from '../../src/db/batches.js';

describe('createBatch()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should insert a batch document', async () => {
    mockDb.collection('batches').insertOne.mockResolvedValue({});
    await createBatch('batch-1', { jobIds: ['j1', 'j2'], userEmail: 'user@test.com', total: 2 });
    expect(mockDb.collection('batches').insertOne).toHaveBeenCalled();
  });
});

describe('getBatch()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return batch for owner', async () => {
    mockDb.collection('batches').findOne.mockResolvedValue({ batch_id: 'b1', user_email: 'user@test.com' });
    const batch = await getBatch('b1', 'user@test.com');
    expect(batch.batch_id).toBe('b1');
  });

  it('should return null when batch not found', async () => {
    mockDb.collection('batches').findOne.mockResolvedValue(null);
    const batch = await getBatch('b999', 'user@test.com');
    expect(batch).toBeNull();
  });

  it('should throw FORBIDDEN for non-owner non-admin', async () => {
    mockDb.collection('batches').findOne.mockResolvedValue({ batch_id: 'b1', user_email: 'other@test.com' });
    await expect(getBatch('b1', 'user@test.com', false)).rejects.toThrow('Forbidden');
  });

  it('should allow admin to view any batch', async () => {
    mockDb.collection('batches').findOne.mockResolvedValue({ batch_id: 'b1', user_email: 'other@test.com' });
    const batch = await getBatch('b1', 'user@test.com', true);
    expect(batch.batch_id).toBe('b1');
  });
});
