import { config } from './config.js';
import { buildServer } from './server.js';
import { getDb, closeDb } from './db/client.js';
import { ensureUserIndexes, ensureOwner, revertExpiredPremiums } from './db/users.js';
import { ensureTicketIndexes, ensureTicketTextIndex } from './db/tickets.js';
import { ensureToolsIndexes } from './db/tools.js';
import { ensureWhitelistIndexes } from './db/whitelist.js';
import { ensureAuditLogIndexes } from './db/auditLog.js';
import { startWorker } from './queue/worker.js';
import { getQueue } from './queue/index.js';
import { getRedis, redisEvents } from './redis/client.js';
import { syncAllBackups, warmupRedis } from './redis/sync.js';
import { activeKeysGauge, cooldownKeysGauge, queueSizeGauge, workerActiveGauge } from './metrics/index.js';
import { notifyAdminQueueBacklog, notifyAdminDailySummary, notifyAdminHighFailureRate } from './services/notifications.js';
import { loadSystemConfigFromDb, seedPlanLimitsToRedis, getFailureRateCount, getSystemConfig } from './redis/systemConfig.js';
import { loadModelConfigFromDb } from './redis/modelConfig.js';
import { syncApiKeysWithDb, seedKeysFromEnv, restoreExpiredKeys, getPoolStats } from './redis/keyPool.js';
import { invalidateUserLimitsCache } from './middleware/rateLimiter.js';
import { writeAuditLog } from './db/auditLog.js';
import { runDailyRotation, hydrateFromMongoIfNeeded } from './services/dailySnapshot.js';

const server = buildServer();

// ── Startup Initialization Sequence ──────────────────────────────────────────

async function bootstrap() {
  // 1. Connect to MongoDB (Required for persistence)
  try {
    await getDb();
    server.log.info('[MongoDB] Connected');

    // Ensure all critical indexes
    await Promise.all([
      ensureUserIndexes(),
      ensureTicketIndexes(),
      ensureTicketTextIndex(),
      ensureWhitelistIndexes(),
      ensureAuditLogIndexes(),
      ensureToolsIndexes(),
    ]);
    await ensureOwner(config.ownerEmail);
  } catch (err) {
    server.log.error({ err }, '[Fatal] Could not connect to MongoDB — persistence disabled');
  }

  // 2. Load System Configuration from MongoDB into Redis
  try {
    const systemLoaded = await loadSystemConfigFromDb();
    if (systemLoaded) {
      server.log.info('[Bootstrap] System config restored from MongoDB');
    } else {
      await seedPlanLimitsToRedis();
      server.log.info('[Bootstrap] System config initialized with defaults');
    }
  } catch (err) {
    server.log.warn({ err }, '[Bootstrap] Failed to load system config');
  }

  // 3. Load Model Configuration from MongoDB into Redis
  try {
    const modelsLoaded = await loadModelConfigFromDb();
    if (modelsLoaded) {
      server.log.info('[Bootstrap] Model config restored from MongoDB');
    }
  } catch (err) {
    server.log.warn({ err }, '[Bootstrap] Failed to load model config');
  }

  // 4. Sycn API Key Pool from MongoDB
  try {
    const keysSynced = await syncApiKeysWithDb();
    if (keysSynced) {
      server.log.info('[Bootstrap] API key pool restored from MongoDB');
    } else if (config.geminiKeys.length > 0) {
      // Empty database — seed from Env for first-run backward compatibility
      await seedKeysFromEnv(config.geminiKeys);
      server.log.info(`[Bootstrap] API key pool seeded from GEMINI_KEYS (${config.geminiKeys.length} keys)`);
    } else {
      server.log.warn('[Bootstrap] API key pool is empty');
    }
  } catch (err) {
    server.log.warn({ err }, '[Bootstrap] Failed to sync API keys');
  }

  // 5. Start BullMQ worker
  startWorker(config.workerConcurrency);
  server.log.info(`[Worker] Started with concurrency ${config.workerConcurrency}`);

  // 6. Hydrate Redis with today's snapshot if data is missing (e.g. after nightly clear or restart)
  try {
    const hydration = await hydrateFromMongoIfNeeded();
    if (hydration.hydrated) {
      server.log.info(`[Bootstrap] Hydrated Redis from ${hydration.date} snapshot`);
    }
  } catch (err) {
    server.log.warn({ err }, '[Bootstrap] Failed to hydrate from snapshot');
  }}

await bootstrap();

// ── Graceful Shutdown ────────────────────────────────────────────────────────

const handleShutdown = async (signal) => {
  server.log.info(`[OS] Received ${signal} — starting graceful shutdown...`);
  
  // 1. Stop taking NEW HTTP requests first
  await server.close();
  server.log.info('[Server] HTTP listener closed');

  // 2. Stop the worker (waits for active jobs to finish)
  await import('./queue/worker.js').then(m => m.stopWorker());

  // 3. Close Redis and MongoDB connections
  const redis = getRedis();
  await redis.quit();
  server.log.info('[Redis] Connection closed');

  await closeDb();
  server.log.info('[MongoDB] Connection closed');

  process.exit(0);
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT',  () => handleShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  server.log.error({ promise, reason }, '[Fatal] Unhandled Rejection at Promise');
});

// ── Multi-Redis Failover & Syncing ──────────────────────────────────────────

// 1. Handle Failover Event: When Redis switches, we must re-seed it from MongoDB
redisEvents.on('failover', async ({ url }) => {
  server.log.warn(`[Failover] New active Redis detected: ${url.split('@').pop()}`);
  try {
    // Sync "as needed" - fresh bootstrap on the new instance
    await warmupRedis(url);
    server.log.info('[Failover] System re-bootstrapped on new Redis instance');
  } catch (err) {
    server.log.error({ err }, '[Failover] Failed to re-bootstrap after switch');
  }
});

// 2. Scheduled Background Sync: Keep all configured Redis instances updated every 3 hours
setInterval(async () => {
  try {
    await syncAllBackups();
  } catch (err) {
    server.log.error({ err }, '[Sync] Periodic backup sync failed');
  }
}, 3 * 60 * 60 * 1000); // 3 hours

// 3. Key Pool Sync: Restore expired cooldown keys every 60s
setInterval(async () => {
  try {
    await restoreExpiredKeys();
  } catch (err) {
    server.log.error({ err }, '[keyPool] background sync failed');
  }
}, 60_000);

// 2. Metrics & Health: consolidated updates every 5 minutes (300s)
setInterval(async () => {
  try {
    const redis = getRedis();
    const queue = getQueue();

    // A. Key Pool Stats
    const pool = await getPoolStats();
    activeKeysGauge.set(pool.active);
    cooldownKeysGauge.set(pool.cooldown);

    // B. Queue Stats & Backlog Alerting
    const [counts, thresholdRaw] = await Promise.all([
      queue.getJobCounts('waiting', 'active', 'completed', 'failed'),
      getSystemConfig('alert_queue_threshold'),
    ]);
    const { waiting = 0, active = 0, completed = 0, failed = 0 } = counts;
    queueSizeGauge.set({ state: 'waiting' },   waiting);
    queueSizeGauge.set({ state: 'active' },    active);
    queueSizeGauge.set({ state: 'completed' }, completed);
    queueSizeGauge.set({ state: 'failed' },    failed);
    workerActiveGauge.set(active);

    const threshold = parseInt(thresholdRaw, 10) || 100;
    if (waiting > threshold) {
      notifyAdminQueueBacklog({ queueSize: waiting, threshold });
    }

    // C. Failure Rate Monitor
    const failThresholdRaw = await getSystemConfig('alert_failure_threshold');
    const failThreshold = parseInt(failThresholdRaw, 10) || 10;
    const failureCount = await getFailureRateCount(5);
    if (failureCount >= failThreshold) {
      notifyAdminHighFailureRate({ failureCount, timeWindowMinutes: 5, threshold: failThreshold });
    }

  } catch (err) {
    server.log.error({ err }, '[monitoring] consolidated background job failed');
  }
}, 300_000);
/* eslint-enable no-inner-declarations */

// Heartbeat: Ping Frontend every 20 minutes to prevent cold starts/hibernation
// setInterval(async () => {
//   try {
//     const start = Date.now();
//     const res = await fetch(config.frontendUrl, { signal: AbortSignal.timeout(10000) });
//     const latency = Date.now() - start;
//     server.log.info({ 
//       url: config.frontendUrl, 
//       status: res.status, 
//       latency_ms: latency 
//     }, '[Heartbeat] Pinged Frontend');
//   } catch (err) {
//     server.log.warn({ 
//       url: config.frontendUrl, 
//       err: err.message 
//     }, '[Heartbeat] Failed to ping Frontend');
//   }
// }, 20 * 60 * 1000);

// Daily summary — fires once per day at 08:00 UTC
scheduleDailySummary();

// Daily Redis rotation — fires at 12:00 AM IST (18:30 UTC)
scheduleDailyRotation();

// Premium Expiry Cleanup — runs once on startup and then every hour
async function cleanupExpiredSubscriptions() {
  try {
    const { reverted, emails = [] } = await revertExpiredPremiums();
    if (reverted > 0) {
      server.log.info({ count: reverted }, '[Subscriptions] Auto-downgraded expired premium accounts');
      // Invalidate Redis caches for these users
      await Promise.all(emails.map(email => invalidateUserLimitsCache(email).catch(() => {})));
      
      // Write to audit log
      writeAuditLog({
        actorEmail: 'system-worker',
        action:     'auto_downgrade',
        meta:       { emails, count: reverted, reason: 'expiry' },
      });
    }
  } catch (err) {
    server.log.error({ err }, '[Subscriptions] Cleanup task failed');
  }
}

// Run immediately on start
cleanupExpiredSubscriptions();
// Then run every hour
setInterval(cleanupExpiredSubscriptions, 60 * 60 * 1000);

// Log Cleanup — delete requests, errors, and snapshots older than 15 days
async function cleanupOldLogs() {
  try {
    const db = await getDb();
    const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

    const [reqResult, errResult, snapResult] = await Promise.all([
      db.collection('requests').deleteMany({ created_at: { $lt: cutoff } }),
      db.collection('errors').deleteMany({ timestamp: { $lt: cutoff } }),
      db.collection('daily_snapshots').deleteMany({ snapshot_at: { $lt: cutoff } }),
    ]);

    const total = (reqResult.deletedCount || 0) + (errResult.deletedCount || 0) + (snapResult.deletedCount || 0);
    if (total > 0) {
      server.log.info({
        requests: reqResult.deletedCount,
        errors: errResult.deletedCount,
        snapshots: snapResult.deletedCount,
      }, `[LogCleanup] Deleted ${total} documents older than 15 days`);
    }
  } catch (err) {
    server.log.error({ err }, '[LogCleanup] Failed to clean old logs');
  }
}

// Run on startup then every 24 hours
cleanupOldLogs();
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);

try {
  await server.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

function scheduleDailySummary() {
  const now = new Date();
  const next8am = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0, 0,
  ));
  if (now >= next8am) next8am.setUTCDate(next8am.getUTCDate() + 1);
  const msUntilFirst = next8am - now;

  setTimeout(async function tick() {
    await sendDailySummary();
    // Schedule the next one in exactly 24h
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, msUntilFirst);
}

// 12:00 AM IST = 18:30 UTC (IST is UTC+5:30)
function scheduleDailyRotation() {
  const now = new Date();
  const nextMidnightIST = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 18, 30, 0, 0,
  ));
  if (now >= nextMidnightIST) nextMidnightIST.setUTCDate(nextMidnightIST.getUTCDate() + 1);
  const msUntilFirst = nextMidnightIST - now;

  const hoursUntil = (msUntilFirst / 3600000).toFixed(1);
  server.log.info(`[DailyRotation] Next run in ${hoursUntil}h (12:00 AM IST)`);

  setTimeout(async function tick() {
    try {
      server.log.info('[DailyRotation] Starting midnight snapshot & cleanup...');
      const result = await runDailyRotation();
      server.log.info({ result }, '[DailyRotation] Completed successfully');
    } catch (err) {
      server.log.error({ err }, '[DailyRotation] Failed');
    }
    // Schedule the next one in exactly 24h
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, msUntilFirst);
}

async function sendDailySummary() {
  try {
    const db = await getDb();
    const yesterday = new Date(Date.now() - 86400 * 1000);

    const [stats] = await db.collection('requests').aggregate([
      { $match: { created_at: { $gte: yesterday } } },
      {
        $group: {
          _id:             null,
          totalRequests:   { $sum: 1 },
          successRequests: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
          errorRequests:   { $sum: { $cond: [{ $ne:  ['$status', 'success'] }, 1, 0] } },
          avgLatencyMs:    { $avg: '$latency_ms' },
          maxLatencyMs:    { $max: '$latency_ms' },
        },
      },
    ]).toArray();

    const topModelDoc = await db.collection('requests').aggregate([
      { $match: { created_at: { $gte: yesterday }, status: 'success' } },
      { $group: { _id: '$model', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]).next();

    const redis = getRedis();
    const [activeKeys, totalUsers] = await Promise.all([
      redis.llen('gemini_keys'),
      db.collection('users').countDocuments(),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    notifyAdminDailySummary({
      date:            today,
      totalRequests:   stats?.totalRequests   ?? 0,
      successRequests: stats?.successRequests ?? 0,
      errorRequests:   stats?.errorRequests   ?? 0,
      avgLatencyMs:    Math.round(stats?.avgLatencyMs ?? 0),
      maxLatencyMs:    stats?.maxLatencyMs    ?? 0,
      activeKeys,
      totalUsers,
      topModel:        topModelDoc?._id ?? null,
    });
  } catch (err) {
    server.log.error({ err }, '[daily-summary] failed to send');
  }
}
