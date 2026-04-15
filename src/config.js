import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  geminiKeys: (process.env.GEMINI_KEYS || '').split(',').map(k => k.trim()).filter(Boolean),
  defaultModel: process.env.DEFAULT_MODEL || 'gemini-2.5-flash',
  cooldownMs: parseInt(process.env.COOLDOWN_MS || '60000', 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || '8', 10),
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '25000', 10),
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
  mongodbName: process.env.MONGODB_NAME || 'keymanagement',
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
  // Email (Now handled by Frontend)
  frontendEmailUrl: process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/api/email/send` : 'http://localhost:3000/api/email/send',
  emailApiSecret: process.env.EMAIL_API_SECRET || '',

  // Auth
  jwtSecret: process.env.JWT_SECRET || (() => {
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
};
