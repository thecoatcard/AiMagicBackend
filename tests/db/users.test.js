import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const createMockCollection = () => ({
    findOne: vi.fn(),
    find: vi.fn(() => ({
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
    })),
    insertOne: vi.fn().mockResolvedValue({ insertedId: { toString: () => 'mock-id' } }),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    updateMany: vi.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    countDocuments: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
    createIndex: vi.fn().mockResolvedValue('ok'),
    createIndexes: vi.fn().mockResolvedValue('ok'),
    findOneAndUpdate: vi.fn(),
  });
  const collections = {};
  return {
    mockDb: {
      collection: vi.fn((name) => {
        if (!collections[name]) collections[name] = createMockCollection();
        return collections[name];
      }),
      _collections: collections,
    },
  };
});
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
}));

import {
  getOrCreateUser, getUser, listUsers, setUserRole,
  setUserStatus, setUserLimits, setUserPlan, deleteUser,
  incrementUserUsage, ensureOwner, getUserStats,
  bulkUpdateUsers, listUsersFiltered,
} from '../../src/db/users.js';

describe('getOrCreateUser()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.collection('users').updateOne.mockResolvedValue({});
    mockDb.collection('users').findOne.mockResolvedValue({ email: 'user@test.com', role: 'user' });
  });

  it('should upsert and return user document', async () => {
    const user = await getOrCreateUser('user@test.com');
    expect(user).toBeDefined();
    expect(mockDb.collection).toHaveBeenCalledWith('users');
    expect(mockDb.collection('users').updateOne).toHaveBeenCalled();
  });
});

describe('getUser()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return user when found', async () => {
    mockDb.collection('users').findOne.mockResolvedValue({ email: 'user@test.com' });
    const user = await getUser('user@test.com');
    expect(user.email).toBe('user@test.com');
  });

  it('should return null when user not found', async () => {
    mockDb.collection('users').findOne.mockResolvedValue(null);
    const user = await getUser('nonexistent@test.com');
    expect(user).toBeNull();
  });
});

describe('listUsers()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockFind = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([{ email: 'a@test.com' }]),
    };
    mockDb.collection('users').find.mockReturnValue(mockFind);
    mockDb.collection('users').countDocuments.mockResolvedValue(1);
  });

  it('should return users and total', async () => {
    const result = await listUsers({ limit: 10, skip: 0 });
    expect(result.users).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});

describe('setUserRole()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true when user found', async () => {
    mockDb.collection('users').updateOne.mockResolvedValue({ matchedCount: 1 });
    const result = await setUserRole('user@test.com', 'admin');
    expect(result).toBe(true);
  });

  it('should return false when user not found', async () => {
    mockDb.collection('users').updateOne.mockResolvedValue({ matchedCount: 0 });
    const result = await setUserRole('none@test.com', 'admin');
    expect(result).toBe(false);
  });
});

describe('setUserStatus()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should update status and return true', async () => {
    mockDb.collection('users').updateOne.mockResolvedValue({ matchedCount: 1 });
    expect(await setUserStatus('user@test.com', 'blocked')).toBe(true);
  });
});

describe('setUserLimits()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return false when no limits provided', async () => {
    expect(await setUserLimits('user@test.com', {})).toBe(false);
  });

  it('should update limits when provided', async () => {
    mockDb.collection('users').updateOne.mockResolvedValue({ matchedCount: 1 });
    expect(await setUserLimits('user@test.com', { max_requests_per_min: 100 })).toBe(true);
  });
});

describe('setUserPlan()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should update plan', async () => {
    mockDb.collection('users').updateOne.mockResolvedValue({ matchedCount: 1 });
    expect(await setUserPlan('user@test.com', 'premium')).toBe(true);
  });
});

describe('deleteUser()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return true when deleted', async () => {
    mockDb.collection('users').deleteOne.mockResolvedValue({ deletedCount: 1 });
    expect(await deleteUser('user@test.com')).toBe(true);
  });

  it('should return false when not found', async () => {
    mockDb.collection('users').deleteOne.mockResolvedValue({ deletedCount: 0 });
    expect(await deleteUser('user@test.com')).toBe(false);
  });
});

describe('incrementUserUsage()', () => {
  it('should not throw (fire-and-forget)', () => {
    expect(() => incrementUserUsage('user@test.com')).not.toThrow();
  });
});

describe('ensureOwner()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should upsert owner with role:owner', async () => {
    mockDb.collection('users').updateOne.mockResolvedValue({});
    await ensureOwner('owner@test.com');
    expect(mockDb.collection('users').updateOne).toHaveBeenCalled();
  });

  it('should do nothing when email is empty', async () => {
    await ensureOwner('');
    expect(mockDb.collection('users').updateOne).not.toHaveBeenCalled();
  });
});

describe('getUserStats()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.collection('users').countDocuments.mockResolvedValue(10);
    mockDb.collection('users').aggregate.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
  });

  it('should return stats object', async () => {
    const stats = await getUserStats();
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('by_role');
    expect(stats).toHaveProperty('by_plan');
  });
});

describe('bulkUpdateUsers()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return matched and modified counts', async () => {
    mockDb.collection('users').updateMany.mockResolvedValue({ matchedCount: 2, modifiedCount: 2 });
    const result = await bulkUpdateUsers(['a@t.com', 'b@t.com'], { status: 'blocked' });
    expect(result.matched).toBe(2);
    expect(result.modified).toBe(2);
  });
});
