import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const cols = {};
  const mkCol = () => ({
    findOne: vi.fn(), find: vi.fn(() => ({ sort: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) })),
    insertOne: vi.fn().mockResolvedValue({}), deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    countDocuments: vi.fn().mockResolvedValue(0), createIndex: vi.fn().mockResolvedValue('ok'),
  });
  return { mockDb: { collection: vi.fn((n) => { if (!cols[n]) cols[n] = mkCol(); return cols[n]; }) } };
});
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
}));

import { isEmailAllowed, listWhitelist, addWhitelistRule, removeWhitelistRule } from '../../src/db/whitelist.js';

describe('isEmailAllowed()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return true when whitelist is empty (open registration)', async () => {
    mockDb.collection('whitelist').countDocuments.mockResolvedValue(0);
    expect(await isEmailAllowed('anyone@test.com')).toBe(true);
  });

  it('should return true when email is in whitelist', async () => {
    mockDb.collection('whitelist').countDocuments.mockResolvedValue(1);
    mockDb.collection('whitelist').findOne.mockResolvedValue({ type: 'email', value: 'user@test.com' });
    expect(await isEmailAllowed('user@test.com')).toBe(true);
  });

  it('should return false when email not in whitelist', async () => {
    mockDb.collection('whitelist').countDocuments.mockResolvedValue(1);
    mockDb.collection('whitelist').findOne.mockResolvedValue(null);
    expect(await isEmailAllowed('blocked@test.com')).toBe(false);
  });
});

describe('addWhitelistRule()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should add a rule', async () => {
    mockDb.collection('whitelist').insertOne.mockResolvedValue({});
    const result = await addWhitelistRule('email', 'user@test.com');
    expect(result.added).toBe(true);
  });

  it('should return already_exists on duplicate', async () => {
    const err = new Error('dup');
    err.code = 11000;
    mockDb.collection('whitelist').insertOne.mockRejectedValue(err);
    const result = await addWhitelistRule('email', 'user@test.com');
    expect(result.added).toBe(false);
    expect(result.reason).toBe('already_exists');
  });
});

describe('removeWhitelistRule()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return true when rule removed', async () => {
    mockDb.collection('whitelist').deleteOne.mockResolvedValue({ deletedCount: 1 });
    expect(await removeWhitelistRule('email', 'user@test.com')).toBe(true);
  });

  it('should return false when rule not found', async () => {
    mockDb.collection('whitelist').deleteOne.mockResolvedValue({ deletedCount: 0 });
    expect(await removeWhitelistRule('email', 'nope@test.com')).toBe(false);
  });
});
