import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  redisUrls: [
    ...(process.env.REDIS_URLS || '').split(',').map(u => u.trim()),
    ...Object.keys(process.env)
      .filter(k => k.startsWith('REDIS_URL_'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map(k => process.env[k]),
  ].filter(Boolean),
  geminiKeys: (process.env.GEMINI_KEYS || '').split(',').map(k => k.trim()).filter(Boolean),
  defaultModel: process.env.DEFAULT_MODEL || 'gemini-3.1-flash-lite-preview',
  cooldownMs: parseInt(process.env.COOLDOWN_MS || '60000', 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || '8', 10),
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '100000', 10),
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
  mongodbName: process.env.MONGODB_NAME || 'keymanagement',
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '1', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  // Email (Now handled by Frontend)
  frontendEmailUrl: process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/api/email/send` : 'http://localhost:3000/api/email/send',
  emailApiSecret: process.env.EMAIL_API_SECRET || '',

  // Auth
  jwtSecret: process.env.JWT_SECRET || (() => {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[config] FATAL: JWT_SECRET must be set in production. Refusing to start with insecure default.');
    }
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[config] WARNING: JWT_SECRET is not set — using insecure default. Set JWT_SECRET in .env before going to production.');
    }
    return 'change-me-in-production';
  })(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  otpTtlMs: parseInt(process.env.OTP_TTL_MS || '600000', 10), // 10 min
  // Owner: this email is permanently the system owner (role:'owner').
  // Set OWNER_EMAIL in .env — seeded to DB on startup and used as an
  // emergency override so lockout is impossible even if DB is corrupted.
  ownerEmail: process.env.OWNER_EMAIL || '',

  // Hivemind — per-user embedding context (dedicated Redis)
  hivemindRedisUrl: process.env.HIVEMIND_REDIS_URL || '',
  hivemindTtlSecs: parseInt(process.env.HIVEMIND_TTL_SECS || '14400', 10), // 4 hours
  hivemindTopK: parseInt(process.env.HIVEMIND_TOP_K || '5', 10),
  hivemindEmbeddingModel: process.env.HIVEMIND_EMBEDDING_MODEL || 'gemini-embedding-2-preview',
  hivemindMaxSnippetLen: parseInt(process.env.HIVEMIND_MAX_SNIPPET_LEN || '500', 10),
};
