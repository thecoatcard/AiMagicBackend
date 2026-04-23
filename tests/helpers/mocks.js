// Reusable mock factories for all tests
import { vi } from 'vitest';

// ─── MongoDB Mock ────────────────────────────────────────────────────────────

export function createMockCollection() {
  return {
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
  };
}

export function createMockDb() {
  const collections = {};
  return {
    collection: vi.fn((name) => {
      if (!collections[name]) collections[name] = createMockCollection();
      return collections[name];
    }),
    _collections: collections,
  };
}

// ─── Redis Mock ──────────────────────────────────────────────────────────────

export function createMockRedis() {
  const mockPipeline = {
    set: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    get: vi.fn().mockReturnThis(),
    hset: vi.fn().mockReturnThis(),
    hincrby: vi.fn().mockReturnThis(),
    hgetall: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };

  const mockMulti = {
    set: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    get: vi.fn().mockReturnThis(),
    hset: vi.fn().mockReturnThis(),
    hincrby: vi.fn().mockReturnThis(),
    hgetall: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };

  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
    hget: vi.fn().mockResolvedValue(null),
    hset: vi.fn().mockResolvedValue(1),
    hgetall: vi.fn().mockResolvedValue({}),
    hdel: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(-1),
    mget: vi.fn().mockResolvedValue([]),
    eval: vi.fn().mockResolvedValue(0),
    llen: vi.fn().mockResolvedValue(0),
    lrange: vi.fn().mockResolvedValue([]),
    lpush: vi.fn().mockResolvedValue(1),
    rpop: vi.fn().mockResolvedValue(null),
    lrem: vi.fn().mockResolvedValue(0),
    zadd: vi.fn().mockResolvedValue(1),
    zrem: vi.fn().mockResolvedValue(1),
    zscore: vi.fn().mockResolvedValue(null),
    zrangebyscore: vi.fn().mockResolvedValue([]),
    zcount: vi.fn().mockResolvedValue(0),
    scan: vi.fn().mockResolvedValue(['0', []]),
    unlink: vi.fn().mockResolvedValue(0),
    ping: vi.fn().mockResolvedValue('PONG'),
    pipeline: vi.fn(() => mockPipeline),
    multi: vi.fn(() => mockMulti),
    scanStream: vi.fn(() => {
      const { EventEmitter } = require('events');
      const stream = new EventEmitter();
      setTimeout(() => { stream.emit('data', []); stream.emit('end'); }, 0);
      return stream;
    }),
    quit: vi.fn().mockResolvedValue('OK'),
    _pipeline: mockPipeline,
    _multi: mockMulti,
  };
}

// ─── Fastify Request/Reply Mock ──────────────────────────────────────────────

export function createMockRequest(overrides = {}) {
  return {
    headers: {},
    query: {},
    params: {},
    body: {},
    method: 'GET',
    user: null,
    ...overrides,
  };
}

export function createMockReply() {
  const reply = {
    _statusCode: 200,
    _body: null,
    status: vi.fn(function (code) { this._statusCode = code; return this; }),
    send: vi.fn(function (body) { this._body = body; return this; }),
    type: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
    raw: { write: vi.fn(), end: vi.fn() },
  };
  return reply;
}
