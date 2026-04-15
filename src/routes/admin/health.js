import { getDb } from '../../db/client.js';
import { getRedis } from '../../redis/client.js';
import { getPoolStats } from '../../redis/keyPool.js';
import { getQueue } from '../../queue/index.js';
import { getAllSystemConfig, getFailureRateCount } from '../../redis/systemConfig.js';

export async function adminHealthRoutes(fastify) {
  // ── GET /v1/admin/health — full system health snapshot ─────────────────────
  fastify.get('/v1/admin/health', async () => {
    const [mongoResult, redisResult, poolResult, queueResult, configResult, failureResult] =
      await Promise.allSettled([
        checkMongo(),
        checkRedis(),
        getPoolStats(),
        getQueue().getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
        getAllSystemConfig(),
        getFailureRateCount(5),
      ]);

    const cfg = configResult.status === 'fulfilled' ? configResult.value : {};

    return {
      timestamp:     new Date().toISOString(),
      mongo:         settle(mongoResult),
      redis:         settle(redisResult),
      key_pool:      settle(poolResult),
      queue:         settle(queueResult),
      failure_rate:  {
        last_5_min:           failureResult.status === 'fulfilled' ? failureResult.value : null,
        alert_threshold:      parseInt(cfg.alert_failure_threshold, 10) || 10,
      },
      system_config: {
        maintenance_mode:     cfg.maintenance_mode    === '1',
        generation_enabled:   cfg.generation_enabled  === '1',
        registration_enabled: cfg.registration_enabled === '1',
        default_per_min:      parseInt(cfg.default_per_min, 10) || 60,
      },
    };
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function settle(result) {
  if (result.status === 'fulfilled') return result.value;
  return { status: 'error', error: result.reason?.message ?? 'unknown' };
}

async function checkMongo() {
  const db = await getDb();
  const [ping, userCount, ticketCount] = await Promise.all([
    db.command({ ping: 1 }),
    db.collection('users').estimatedDocumentCount(),
    db.collection('tickets').estimatedDocumentCount(),
  ]);
  return {
    status:       ping.ok === 1 ? 'up' : 'degraded',
    user_count:   userCount,
    ticket_count: ticketCount,
  };
}

async function checkRedis() {
  const redis = getRedis();
  const start = Date.now();
  await redis.ping();
  const latencyMs = Date.now() - start;

  const info = await redis.info('memory');
  const memMatch  = info.match(/used_memory_human:([^\r\n]+)/);
  const peakMatch = info.match(/used_memory_peak_human:([^\r\n]+)/);

  return {
    status:           'up',
    latency_ms:       latencyMs,
    used_memory:      memMatch  ? memMatch[1].trim()  : null,
    peak_memory:      peakMatch ? peakMatch[1].trim() : null,
  };
}
