import Fastify from 'fastify';
import { mkdirSync } from 'fs';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { authenticate } from './auth/middleware.js';
import { requireAdmin, requireOwner } from './auth/roles.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { generateRoutes } from './routes/generate.js';
import { systemRoutes } from './routes/system.js';
import { keysRoutes } from './routes/keys.js';
import { modelsRoutes } from './routes/models.js';
import { streamRoutes } from './routes/stream.js';
import { analyticsRoutes } from './routes/analytics.js';
import { batchRoutes } from './routes/batch.js';
import { queueRoutes } from './routes/queue.js';
import { metricsRoutes } from './routes/metrics.js';
import { debugRoutes } from './routes/debug.js';
import { usersRoutes } from './routes/users.js';
import { ticketsRoutes } from './routes/tickets.js';
import { toolsRoutes } from './routes/tools.js';
import { checkMaintenanceMode } from './middleware/systemChecks.js';
import { adminSystemRoutes } from './routes/admin/system.js';
import { adminAlertsRoutes } from './routes/admin/alerts.js';
import { adminHealthRoutes } from './routes/admin/health.js';
import { adminAuditRoutes } from './routes/admin/audit.js';
import { adminToolsRoutes } from './routes/admin/tools.js';
import { referralRoutes } from './routes/referrals.js';


export function buildServer() {
  mkdirSync('uploads/payments', { recursive: true });
  mkdirSync('uploads/tickets', { recursive: true });

  const fastify = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
    // Allow up to 20 MB bodies to support base64-encoded image uploads
    bodyLimit: 20 * 1024 * 1024,
  });

  fastify.register(sensible);
  fastify.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100 MB
      files: 1,
    },
  });
  fastify.register(cors, {
    origin: (process.env.CORS_ORIGINS || 'http://localhost:3001')
      .split(',')
      .map(o => o.trim()),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition', 'Content-Length'],
    credentials: true,
  });

  // Public routes — no auth required
  fastify.register(healthRoutes);
  fastify.register(authRoutes);

  // Protected routes — all /v1/* require a valid JWT
  fastify.register(async (instance) => {
    instance.addHook('preHandler', authenticate);
    // Maintenance mode check runs after auth so admins can bypass it
    instance.addHook('preHandler', checkMaintenanceMode);

    // System config (payment details, QR) — needed by payment modal for any
    // authenticated user; not admin-only.
    instance.register(systemRoutes);

    // ── User + Admin endpoints ───────────────────────────────────────────────
    // generate, stream, batch — rate-limited per user (via route-level preHandler)
    instance.register(generateRoutes);
    instance.register(streamRoutes);
    instance.register(batchRoutes);
    // analytics — /v1/logs & /v1/usage user-filtered; /v1/errors admin-only (inline)
    instance.register(analyticsRoutes);
    // users — /v1/users/me open; admin sub-routes protected inline
    instance.register(usersRoutes);
    // tickets — ownership checked inline; admin-only mutate routes protected inline
    instance.register(ticketsRoutes);
    // tools — active tools visible to all; download tracked; admin CRUD inline
    instance.register(toolsRoutes);
    // models — listing available models is public for chat settings; admin routes protected inline
    instance.register(modelsRoutes);
    instance.register(referralRoutes);


    // ── Admin-only endpoints (Common) ────────────────────────────────────────
    instance.register(async (admin) => {
      admin.addHook('preHandler', requireAdmin);
      // Currently empty as specific modules are moved to owner block below.
      // usersRoutes and ticketsRoutes are registered above and handles roles internally.
    });

    // ── Owner-only endpoints (Sensitive) ─────────────────────────────────────
    instance.register(async (owner) => {
      owner.addHook('preHandler', requireOwner);

      owner.register(keysRoutes);
      owner.register(queueRoutes);
      owner.register(metricsRoutes);
      owner.register(debugRoutes);

      // Admin control panel routes now restricted to owner
      owner.register(adminSystemRoutes);
      owner.register(adminAlertsRoutes);
      owner.register(adminHealthRoutes);
      owner.register(adminAuditRoutes);
      owner.register(adminToolsRoutes);
    });
  });

  return fastify;
}
