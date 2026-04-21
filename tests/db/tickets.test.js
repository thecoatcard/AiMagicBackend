import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const cols = {};
  const mkCol = () => ({
    findOne: vi.fn(), find: vi.fn(() => ({ sort: vi.fn().mockReturnThis(), skip: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) })),
    insertOne: vi.fn().mockResolvedValue({ insertedId: { toString: () => '507f1f77bcf86cd799439011' } }),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    countDocuments: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
    createIndex: vi.fn().mockResolvedValue('ok'),
    findOneAndUpdate: vi.fn(), updateMany: vi.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
  });
  return { mockDb: { collection: vi.fn((n) => { if (!cols[n]) cols[n] = mkCol(); return cols[n]; }) } };
});
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
}));

import { createTicket, getTicketById, listTickets, updateTicket, deleteTicket, getTicketStats, bulkCloseTickets } from '../../src/db/tickets.js';

describe('createTicket()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const fakeId = { toString: () => '507f1f77bcf86cd799439011' };
    mockDb.collection('tickets').insertOne.mockResolvedValue({ insertedId: fakeId });
    mockDb.collection('tickets').findOne.mockResolvedValue({
      _id: fakeId,
      user_email: 'user@test.com',
      subject: 'Bug',
      description: 'desc',
      priority: 'medium',
      status: 'open',
      admin_response: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
  });

  it('should create and return a ticket', async () => {
    const ticket = await createTicket({ userEmail: 'user@test.com', subject: 'Bug', description: 'desc' });
    expect(ticket).toBeDefined();
    expect(ticket.id).toBeDefined();
    expect(ticket.status).toBe('open');
  });
});

describe('getTicketById()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return null for invalid id', async () => {
    mockDb.collection('tickets').findOne.mockRejectedValue(new Error('invalid'));
    const result = await getTicketById('invalid');
    expect(result).toBeNull();
  });
});

describe('listTickets()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockFind = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
    };
    mockDb.collection('tickets').find.mockReturnValue(mockFind);
    mockDb.collection('tickets').countDocuments.mockResolvedValue(0);
  });

  it('should return tickets and total', async () => {
    const result = await listTickets();
    expect(result).toHaveProperty('tickets');
    expect(result).toHaveProperty('total');
  });
});

describe('deleteTicket()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return true when deleted', async () => {
    mockDb.collection('tickets').deleteOne.mockResolvedValue({ deletedCount: 1 });
    expect(await deleteTicket('507f1f77bcf86cd799439011')).toBe(true);
  });

  it('should return false for invalid id', async () => {
    mockDb.collection('tickets').deleteOne.mockRejectedValue(new Error('bad id'));
    expect(await deleteTicket('invalid')).toBe(false);
  });
});

describe('getTicketStats()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.collection('tickets').countDocuments.mockResolvedValue(5);
    mockDb.collection('tickets').aggregate.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
  });

  it('should return stats', async () => {
    const stats = await getTicketStats();
    expect(stats.total).toBe(5);
    expect(stats).toHaveProperty('by_status');
    expect(stats).toHaveProperty('by_priority');
  });
});
