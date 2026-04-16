import { getDb } from '../../db/client.js';
import { getRedis } from '../../redis/client.js';
import { getPoolStats } from '../../redis/keyPool.js';
import { getQueue } from '../../queue/index.js';
import { getAllSystemConfig, getFailureRateCount } from '../../redis/systemConfig.js';
import { getMetricSummary } from '../../metrics/index.js';
import { config as nodeConfig } from '../../config.js';

export async function adminHealthRoutes(fastify) {
  // ── GET /v1/admin/health — full system health snapshot ─────────────────────
  fastify.get('/v1/admin/health', async () => {
    const [
      mongoResult, 
      redisResult, 
      poolResult, 
      queueResult, 
      configResult, 
      failureResult,
      queueWaitSummary,
      genLatencySummary
    ] = await Promise.allSettled([
      checkMongo(),
      checkRedis(),
      getPoolStats(),
      getQueue().getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
      getAllSystemConfig(),
      getFailureRateCount(5),
      getMetricSummary('gemini_queue_wait_ms'),
      getMetricSummary('gemini_request_duration_ms')
    ]);

    const cfg = configResult.status === 'fulfilled' ? configResult.value : {};
    const failCount = failureResult.status === 'fulfilled' ? failureResult.value : 0;
    const threshold = parseInt(cfg.alert_failure_threshold, 10) || 10;
    const activeJobs = queueResult.status === 'fulfilled' ? queueResult.value.active : 0;
    const concurrency = nodeConfig.workerConcurrency || 1;

    // Determine System Pulse
    let pulse = 'healthy';
    if (failCount > threshold * 2) pulse = 'critical';
    else if (failCount > threshold || (activeJobs / concurrency) > 0.9) pulse = 'degraded';

    return {
      timestamp:     new Date().toISOString(),
      pulse,
      load_pct:      Math.min(100, Math.round((activeJobs / concurrency) * 100)),
      mongo:         settle(mongoResult),
      redis:         settle(redisResult),
      key_pool:      settle(poolResult),
      queue:         settle(queueResult),
      latency: {
        queue_wait:  settle(queueWaitSummary),
        generation: settle(genLatencySummary)
      },
      failure_rate:  {
        last_5_min:           failCount,
        alert_threshold:      threshold,
      },
      system_config: {
        maintenance_mode:     cfg.maintenance_mode    === '1',
        generation_enabled:   cfg.generation_enabled  === '1',
        registration_enabled: cfg.registration_enabled === '1',
        default_per_min:      parseInt(cfg.default_per_min, 10) || 60,
        worker_concurrency:   concurrency,
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
