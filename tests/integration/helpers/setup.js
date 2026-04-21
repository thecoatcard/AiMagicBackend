/**
 * Integration test helper — builds a real Fastify server with all routes registered,
 * but mocks all external I/O (MongoDB, Redis, email, notifications, etc.).
 *
 * Tests use fastify.inject() to send real HTTP requests through the full middleware chain.
 */
import { vi } from 'vitest';
import jwt from 'jsonwebtoken';

// ── JWT helpers ──────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-for-integration';
const SESSION_ID = 'test-session-id-abc123';

export function makeToken(payload = {}, options = {}) {
  const defaults = {
    email: 'user@test.com',
    sessionId: SESSION_ID,
    role: 'user',
    plan: 'free',
  };
  return jwt.sign({ ...defaults, ...payload }, JWT_SECRET, { expiresIn: '1h', ...options });
}

export function makeAdminToken(overrides = {}) {
  return makeToken({ email: 'admin@test.com', role: 'admin', ...overrides });
}

export function makeOwnerToken(overrides = {}) {
  return makeToken({ email: 'owner@test.com', role: 'owner', ...overrides });
}

export function makeExpiredToken() {
  return jwt.sign(
    { email: 'user@test.com', sessionId: SESSION_ID, role: 'user', plan: 'free' },
    JWT_SECRET,
    { expiresIn: '-1s' },
  );
}

// ── Mock wiring for all external deps ────────────────────────────────────────

// Config mock — must be set before server import
vi.mock('../../../src/config.js', () => ({
  config: {
    port: 3999,
    jwtSecret: 'test-secret-for-integration',
    jwtExpiresIn: '1h',
    ownerEmail: 'owner@test.com',
    redisUrls: [],
    geminiKeys: [],
    defaultModel: 'test-model',
    cooldownMs: 60000,
    maxRetries: 3,
    requestTimeoutMs: 10000,
    mongodbUri: 'mongodb://localhost:27017',
    mongodbName: 'test',
    workerConcurrency: 1,
    frontendUrl: 'http://localhost:3000',
    frontendEmailUrl: 'http://localhost:3000/api/email/send',
    emailApiSecret: 'test-email-secret',
    otpTtlMs: 600000,
  },
}));

// Redis mock
const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  eval: vi.fn().mockResolvedValue([1, 60]),
  zscore: vi.fn().mockResolvedValue(Date.now().toString()),
  zadd: vi.fn().mockResolvedValue(1),
  zrem: vi.fn().mockResolvedValue(1),
  ping: vi.fn().mockResolvedValue('PONG'),
  keys: vi.fn().mockResolvedValue([]),
  hgetall: vi.fn().mockResolvedValue({}),
  hget: vi.fn().mockResolvedValue(null),
  hset: vi.fn().mockResolvedValue(1),
  incr: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
  ttl: vi.fn().mockResolvedValue(-1),
  mget: vi.fn().mockResolvedValue([]),
  pipeline: vi.fn(() => ({
    set: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    get: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  })),
  scanStream: vi.fn(() => {
    const { EventEmitter } = require('events');
    const stream = new EventEmitter();
    setTimeout(() => { stream.emit('data', []); stream.emit('end'); }, 0);
    return stream;
  }),
};
vi.mock('../../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));

// Session validation — make zscore return a valid score so sessions pass
vi.mock('../../../src/redis/systemConfig.js', () => ({
  isMaintenanceMode: vi.fn().mockResolvedValue(false),
  isGenerationEnabled: vi.fn().mockResolvedValue(true),
  isRegistrationEnabled: vi.fn().mockResolvedValue(true),
  getMaxSessionsUser: vi.fn().mockResolvedValue(1),
  getMaxSessionsAdmin: vi.fn().mockResolvedValue(3),
  getDefaultPerMin: vi.fn().mockResolvedValue(60),
  getPlanDailyLimit: vi.fn().mockResolvedValue(1000),
  getAllSystemConfig: vi.fn(async () => ({})),
  setSystemConfig: vi.fn(async () => 'OK'),
  bustAllUserCaches: vi.fn(async () => undefined),
  getFailureRateCount: vi.fn(async () => 0),
  recordFailureRateTick: vi.fn(),
}));

// DB mocks
const mockUserDoc = {
  email: 'user@test.com',
  role: 'user',
  status: 'active',
  plan: 'free',
  limits: {},
  usage: { today: 0 },
  created_at: new Date().toISOString(),
};

const mockAdminDoc = {
  email: 'admin@test.com',
  role: 'admin',
  status: 'active',
  plan: 'premium',
  limits: {},
  usage: { today: 0 },
  created_at: new Date().toISOString(),
};

const mockOwnerDoc = {
  email: 'owner@test.com',
  role: 'owner',
  status: 'active',
  plan: 'premium',
  limits: {},
  usage: { today: 0 },
  created_at: new Date().toISOString(),
};

vi.mock('../../../src/db/users.js', () => ({
  getUser: vi.fn(async (email) => {
    if (email === 'admin@test.com') return mockAdminDoc;
    if (email === 'owner@test.com') return mockOwnerDoc;
    if (email === 'blocked@test.com') return { ...mockUserDoc, email: 'blocked@test.com', status: 'blocked' };
    return { ...mockUserDoc, email };
  }),
  getOrCreateUser: vi.fn(async (email) => ({ email, role: 'user', plan: 'free' })),
  listUsers: vi.fn(async () => ({ users: [mockUserDoc], total: 1 })),
  listUsersFiltered: vi.fn(async () => ({ users: [mockUserDoc], total: 1 })),
  getUserStats: vi.fn(async () => ({ total: 10, active: 8, blocked: 2 })),
  bulkUpdateUsers: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  setUserRole: vi.fn(),
  setUserStatus: vi.fn(),
  setUserLimits: vi.fn(),
  setUserPlan: vi.fn(),
  deleteUser: vi.fn(),
  incrementUserUsage: vi.fn(),
}));

vi.mock('../../../src/db/whitelist.js', () => ({
  isEmailAllowed: vi.fn().mockResolvedValue(true),
  listWhitelist: vi.fn(async () => []),
  addWhitelistRule: vi.fn(async () => ({ insertedId: 'mock-id' })),
  removeWhitelistRule: vi.fn(async () => ({ deletedCount: 1 })),
}));

vi.mock('../../../src/db/client.js', () => {
  const mockCollection = {
    findOne: vi.fn(),
    find: vi.fn(() => ({
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
    })),
    insertOne: vi.fn().mockResolvedValue({ insertedId: 'mock-id' }),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    countDocuments: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
  };
  return {
    getDb: vi.fn(async () => ({
      collection: vi.fn(() => mockCollection),
    })),
  };
});

vi.mock('../../../src/db/tickets.js', () => ({
  createTicket: vi.fn(async (data) => ({
    id: 'ticket-001',
    ...data,
    status: 'open',
    created_at: new Date().toISOString(),
  })),
  getTicketById: vi.fn(async (id) => ({
    id,
    user_email: 'user@test.com',
    subject: 'Test ticket',
    description: 'Test description for this ticket',
    status: 'open',
    priority: 'medium',
    created_at: new Date().toISOString(),
  })),
  listTickets: vi.fn(async () => ({ tickets: [], total: 0 })),
  updateTicket: vi.fn(),
  deleteTicket: vi.fn(),
  getTicketStats: vi.fn(async () => ({ total: 5, open: 2, resolved: 3 })),
  bulkCloseTickets: vi.fn(async () => ({ modified: 2 })),
}));

vi.mock('../../../src/db/tools.js', () => ({
  getTool: vi.fn(async (id) => ({
    id,
    name: 'Test Tool',
    description: 'A test tool',
    type: 'external',
    external_url: 'https://example.com/tool',
    is_active: true,
    tags: ['test'],
    downloads: 0,
    created_at: new Date().toISOString(),
  })),
  listTools: vi.fn(async () => ([
    {
      id: 'tool-1',
      name: 'Tool One',
      description: 'First tool',
      type: 'external',
      is_active: true,
      tags: ['ai'],
      downloads: 42,
    },
  ])),
  incrementDownloadCount: vi.fn(),
  createTool: vi.fn(async (data) => ({ id: 'new-tool-id', ...data })),
  updateTool: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  deleteTool: vi.fn(async () => ({ deletedCount: 1 })),
  toggleToolActive: vi.fn(async () => ({ is_active: true })),
}));

vi.mock('../../../src/db/gridfs.js', () => ({
  getToolsBucket: vi.fn(async () => ({
    openUploadStream: vi.fn(() => {
      const { EventEmitter } = require('events');
      const stream = new EventEmitter();
      stream.pipe = vi.fn();
      stream.id = { toString: () => 'gridfs-id-123' };
      setTimeout(() => stream.emit('finish'), 0);
      return stream;
    }),
    openDownloadStream: vi.fn(),
  })),
}));

vi.mock('../../../src/db/apiKeys.js', () => ({}));
vi.mock('../../../src/db/auditLog.js', () => ({
  writeAuditLog: vi.fn(),
  listAuditLog: vi.fn(async () => ({ logs: [], total: 0 })),
}));
vi.mock('../../../src/db/logger.js', () => ({
  logRequest: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../../src/db/batches.js', () => ({
  createBatch: vi.fn(async (data) => ({ id: 'batch-001', ...data, status: 'pending' })),
  getBatch: vi.fn(async () => ({ id: 'batch-001', status: 'completed', results: [] })),
}));

// Auth mocks
vi.mock('../../../src/auth/otp.js', () => ({
  generateOtp: vi.fn().mockResolvedValue('123456'),
  verifyOtp: vi.fn(async (email, otp) => {
    if (otp === '123456') return { valid: true };
    return { valid: false, reason: 'Invalid OTP' };
  }),
}));

vi.mock('../../../src/auth/session.js', () => ({
  createSession: vi.fn(async (email, role) => ({
    token: jwt.sign(
      { email, sessionId: 'new-session-id', role, plan: 'free' },
      'test-secret-for-integration',
      { expiresIn: '1h' },
    ),
    wasSuperseded: false,
  })),
  invalidateSession: vi.fn().mockResolvedValue(undefined),
  validateSession: vi.fn(async (token) => {
    try {
      const payload = jwt.verify(token, 'test-secret-for-integration');
      return { valid: true, email: payload.email, sessionId: payload.sessionId, role: payload.role, plan: payload.plan };
    } catch {
      return { valid: false, reason: 'invalid_token' };
    }
  }),
}));

// Services mocks
vi.mock('../../../src/services/email.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/notifications.js', () => ({
  notifyNewDeviceLogin: vi.fn(),
  notifySessionInvalidated: vi.fn(),
  notifyTicketCreated: vi.fn(),
  notifyTicketReply: vi.fn(),
  notifyTicketClosed: vi.fn(),
  notifyAdminNewTicket: vi.fn(),
  notifyQuotaWarning: vi.fn(),
  notifyAdminNoKeys: vi.fn(),
  notifyAdminKeyDisabled: vi.fn(),
  notifyAccountBlocked: vi.fn(),
  notifyAccountUnblocked: vi.fn(),
  notifyPlanChanged: vi.fn(),
  notifyAdminDailySummary: vi.fn(),
}));

vi.mock('../../../src/services/orchestrator.js', () => ({
  runGenerate: vi.fn(async ({ prompt, model }) => ({
    text: `Response to: ${prompt}`,
    model: model || 'test-model',
    latency_ms: 123,
    retries: 0,
    status: 'success',
  })),
  runEmbed: vi.fn(async () => ({
    embedding: [0.1, 0.2, 0.3],
    model: 'text-embedding',
  })),
  maskKey: vi.fn((k) => k ? `${k.slice(0, 4)}...${k.slice(-4)}` : '****'),
}));

vi.mock('../../../src/services/gemini.js', () => ({
  streamGenerateContent: vi.fn(),
  generateContent: vi.fn(async () => ({ text: 'test response' })),
}));

vi.mock('../../../src/services/fileParsers.js', () => ({
  parseFileToContent: vi.fn((f) => ({ mimeType: f.mimeType, data: f.data })),
}));

vi.mock('../../../src/services/alertThrottle.js', () => ({}));
vi.mock('../../../src/services/dailySnapshot.js', () => ({}));

// Redis sub-module mocks
vi.mock('../../../src/redis/keyPool.js', () => ({
  listKeys: vi.fn(async () => [{ key: 'AIza...xxxx', status: 'active' }]),
  addKey: vi.fn(async () => ({ status: 'added' })),
  enableKey: vi.fn(),
  disableKey: vi.fn(),
  clearAllCooldowns: vi.fn(),
  getPoolStats: vi.fn(async () => ({ active: 1, cooldown: 0, disabled: 0 })),
  getKey: vi.fn(async () => 'test-key'),
  returnKey: vi.fn(),
  cooldownKey: vi.fn(),
  recordKeySuccess: vi.fn(),
  recordKeyFailure: vi.fn(),
  isPoolExhausted: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../../src/redis/modelHealth.js', () => ({
  listAllModels: vi.fn(async () => [{ model: 'test-model', success: 10, failure: 0 }]),
  getModelStats: vi.fn(async () => ({ model: 'test-model', success: 10, failure: 0, last_updated: Date.now() })),
  resetModelStats: vi.fn(),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  getBestModel: vi.fn(async () => 'test-model'),
}));

vi.mock('../../../src/redis/modelConfig.js', () => ({
  getModelConfig: vi.fn(async () => ({ primary: 'test-model', fallback: ['fallback-1'] })),
  updateModelConfig: vi.fn(),
  addFallbackModel: vi.fn(),
  removeFallbackModel: vi.fn(),
  getFallbackModels: vi.fn(async () => ['test-model', 'fallback-1']),
  getImageModels: vi.fn(async () => ['test-model']),
}));

vi.mock('../../../src/redis/sync.js', () => ({}));

// Rate limiter — allow requests to pass by default
vi.mock('../../../src/middleware/rateLimiter.js', () => ({
  checkUserRateLimit: vi.fn(async (request, reply) => {
    // pass-through by default; tests can override
  }),
  checkBatchRateLimit: vi.fn(async (request, reply) => {
    // pass-through by default
  }),
  invalidateUserLimitsCache: vi.fn(),
  getDailyUsage: vi.fn(async () => 5),
}));

// Metrics mock
vi.mock('../../../src/metrics/index.js', () => ({
  requestsTotal: { inc: vi.fn() },
  requestDuration: { observe: vi.fn() },
  retriesTotal: { inc: vi.fn() },
  keyCooldownsTotal: { inc: vi.fn() },
  model503Total: { inc: vi.fn() },
  modelTimeoutsTotal: { inc: vi.fn() },
  activeKeysGauge: { set: vi.fn() },
  cooldownKeysGauge: { set: vi.fn() },
  queueSizeGauge: { set: vi.fn() },
  workerActiveGauge: { set: vi.fn() },
  getMetricSummary: vi.fn(async () => ({ count: 0, sum: 0 })),
  registry: {
    contentType: 'text/plain',
    metrics: vi.fn(async () => '# HELP test\n'),
  },
}));

// Queue mocks
vi.mock('../../../src/queue/index.js', () => ({
  getQueue: vi.fn(() => ({
    add: vi.fn(),
    getJob: vi.fn(),
    getJobs: vi.fn().mockResolvedValue([]),
    getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, completed: 0, failed: 0 }),
    obliterate: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  })),
}));

vi.mock('../../../src/queue/worker.js', () => ({}));

// Plans config
vi.mock('../../../src/config/plans.js', () => ({
  getDailyLimit: vi.fn(() => 100),
  PLANS: { free: { daily: 100 }, premium: { daily: 1000 } },
  ASSIGNABLE_PLANS: ['free', 'premium'],
}));

// ── Build server for tests ───────────────────────────────────────────────────

export async function buildTestServer() {
  // Dynamic import after all mocks are in place
  const { buildServer } = await import('../../../src/server.js');
  const app = buildServer();
  await app.ready();
  return app;
}

export { mockRedis, JWT_SECRET, SESSION_ID };
