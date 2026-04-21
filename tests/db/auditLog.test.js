import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const cols = {};
  const mkCol = () => ({
    findOne: vi.fn(), find: vi.fn(() => ({ sort: vi.fn().mockReturnThis(), skip: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) })),
    insertOne: vi.fn().mockResolvedValue({}), updateOne: vi.fn().mockResolvedValue({}),
    countDocuments: vi.fn().mockResolvedValue(0), createIndex: vi.fn().mockResolvedValue('ok'),
  });
  return { mockDb: { collection: vi.fn((n) => { if (!cols[n]) cols[n] = mkCol(); return cols[n]; }) } };
});
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
}));

import { writeAuditLog, listAuditLog, ensureAuditLogIndexes } from '../../src/db/auditLog.js';

describe('writeAuditLog()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should not throw (fire-and-forget)', () => {
    expect(() => writeAuditLog({
      actorEmail: 'admin@test.com',
      action: 'block_user',
      targetEmail: 'user@test.com',
    })).not.toThrow();
  });
});

describe('listAuditLog()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockFind = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([{ action: 'test' }]),
    };
    mockDb.collection('audit_log').find.mockReturnValue(mockFind);
    mockDb.collection('audit_log').countDocuments.mockResolvedValue(1);
  });

  it('should return logs and total', async () => {
    const result = await listAuditLog();
    expect(result.logs).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('should apply filters', async () => {
    await listAuditLog({ actorEmail: 'admin@test.com', action: 'block_user' });
    expect(mockDb.collection('audit_log').find).toHaveBeenCalled();
  });
});

describe('ensureAuditLogIndexes()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should create indexes', async () => {
    mockDb.collection('audit_log').createIndex.mockResolvedValue('ok');
    await ensureAuditLogIndexes();
    expect(mockDb.collection('audit_log').createIndex).toHaveBeenCalled();
  });
});
