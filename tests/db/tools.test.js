import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const cols = {};
  const mkCol = () => ({
    findOne: vi.fn(), find: vi.fn(() => ({ sort: vi.fn().mockReturnThis(), skip: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) })),
    insertOne: vi.fn().mockResolvedValue({ insertedId: { toString: () => '507f1f77bcf86cd799439011' } }),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    countDocuments: vi.fn().mockResolvedValue(0),
    findOneAndUpdate: vi.fn(),
    createIndex: vi.fn().mockResolvedValue('ok'),
  });
  return { mockDb: { collection: vi.fn((n) => { if (!cols[n]) cols[n] = mkCol(); return cols[n]; }) } };
});
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
}));
vi.mock('../../src/db/gridfs.js', () => ({
  getToolsBucket: vi.fn().mockResolvedValue({ delete: vi.fn() }),
}));

import { createTool, getTool, listTools, updateTool, deleteTool, toggleToolActive, incrementDownloadCount } from '../../src/db/tools.js';

describe('createTool()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const fakeId = { toString: () => '507f1f77bcf86cd799439011' };
    mockDb.collection('tools').insertOne.mockResolvedValue({ insertedId: fakeId });
  });

  it('should insert and return a tool', async () => {
    const tool = await createTool({
      name: 'My Tool',
      description: 'A test tool',
      type: 'external',
      created_by: 'admin@test.com',
    });
    expect(tool).toBeDefined();
    expect(tool.name).toBe('My Tool');
  });
});

describe('getTool()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return null for invalid id', async () => {
    mockDb.collection('tools').findOne.mockRejectedValue(new Error('bad'));
    expect(await getTool('invalid')).toBeNull();
  });
});

describe('listTools()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockFind = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
    };
    mockDb.collection('tools').find.mockReturnValue(mockFind);
    mockDb.collection('tools').countDocuments.mockResolvedValue(0);
  });

  it('should return items and total', async () => {
    const result = await listTools();
    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('total');
  });
});

describe('deleteTool()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return false for invalid id', async () => {
    mockDb.collection('tools').findOne.mockRejectedValue(new Error('bad'));
    expect(await deleteTool('invalid')).toBe(false);
  });

  it('should delete tool and return true', async () => {
    mockDb.collection('tools').findOne.mockResolvedValue({ _id: 'id', file_id: null });
    mockDb.collection('tools').deleteOne.mockResolvedValue({ deletedCount: 1 });
    expect(await deleteTool('507f1f77bcf86cd799439011')).toBe(true);
  });
});

describe('incrementDownloadCount()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return new count', async () => {
    mockDb.collection('tools').findOneAndUpdate.mockResolvedValue({ download_count: 5 });
    expect(await incrementDownloadCount('507f1f77bcf86cd799439011')).toBe(5);
  });

  it('should return null for invalid id', async () => {
    mockDb.collection('tools').findOneAndUpdate.mockRejectedValue(new Error('bad'));
    expect(await incrementDownloadCount('invalid')).toBeNull();
  });
});
