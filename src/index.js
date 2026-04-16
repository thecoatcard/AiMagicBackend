import { config } from './config.js';
import { buildServer } from './server.js';
import { getDb } from './db/client.js';
import { ensureUserIndexes, ensureOwner } from './db/users.js';
import { ensureTicketIndexes, ensureTicketTextIndex } from './db/tickets.js';
import { ensureToolsIndexes } from './db/tools.js';
import { ensureWhitelistIndexes } from './db/whitelist.js';
import { ensureAuditLogIndexes } from './db/auditLog.js';
import { startWorker } from './queue/worker.js';
import { getQueue } from './queue/index.js';
import { getRedis } from './redis/client.js';
import { activeKeysGauge, cooldownKeysGauge, queueSizeGauge, workerActiveGauge } from './metrics/index.js';
import { notifyAdminQueueBacklog, notifyAdminDailySummary, notifyAdminHighFailureRate } from './services/notifications.js';
import { loadSystemConfigFromDb, seedPlanLimitsToRedis, getFailureRateCount, getSystemConfig } from './redis/systemConfig.js';
import { loadModelConfigFromDb } from './redis/modelConfig.js';
import { syncApiKeysWithDb, seedKeysFromEnv, restoreExpiredKeys } from './redis/keyPool.js';

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
}

await bootstrap();

// Background job: restore expired cooldown keys + update gauges every 5s
setInterval(async () => {
  try {
    await restoreExpiredKeys();

    // Update key pool gauges
    const redis = getRedis();
    const [activeCount, cooldownCount] = await Promise.all([
      redis.llen('gemini_keys'),
      redis.zcard('gemini_keys_cooldown'),
    ]);
    activeKeysGauge.set(activeCount);
    cooldownKeysGauge.set(cooldownCount);
  } catch (err) {
    server.log.error({ err }, '[keyPool] background job failed');
  }
}, 5_000);

// Update queue gauges every 10s + alert on backlog (threshold read from Redis)
setInterval(async () => {
  try {
    const queue = getQueue();
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed');
    const { waiting = 0, active = 0, completed = 0, failed = 0 } = counts;
    queueSizeGauge.set({ state: 'waiting' },   waiting);
    queueSizeGauge.set({ state: 'active' },    active);
    queueSizeGauge.set({ state: 'completed' }, completed);
    queueSizeGauge.set({ state: 'failed' },    failed);
    workerActiveGauge.set(active);

    const thresholdRaw = await getSystemConfig('alert_queue_threshold');
    const threshold = parseInt(thresholdRaw, 10) || QUEUE_BACKLOG_THRESHOLD_DEFAULT;
    if (waiting > threshold) {
      notifyAdminQueueBacklog({ queueSize: waiting, threshold });
    }
  } catch (err) {
    server.log.error({ err }, '[queue] gauge update failed');
  }
}, 10_000);

// Failure rate monitor — checks every 60s, alerts if failure count in last 5 min exceeds threshold
setInterval(async () => {
  try {
    const thresholdRaw = await getSystemConfig('alert_failure_threshold');
    const threshold = parseInt(thresholdRaw, 10) || 10;
    const failureCount = await getFailureRateCount(5);
    if (failureCount >= threshold) {
      notifyAdminHighFailureRate({ failureCount, timeWindowMinutes: 5, threshold });
    }
  } catch (err) {
    server.log.error({ err }, '[failureRate] monitor failed');
  }
}, 60_000);

// Daily summary — fires once per day at 08:00 UTC
scheduleDailySummary();

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
