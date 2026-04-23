import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

// Collect default Node.js metrics (heap, CPU, event loop lag, etc.)
collectDefaultMetrics({ register: registry });

// ─── Request metrics ────────────────────────────────────────────────────────

export const requestsTotal = new Counter({
  name: 'gemini_requests_total',
  help: 'Total number of generation requests',
  labelNames: ['model', 'status'],
  registers: [registry],
});

export const requestDuration = new Histogram({
  name: 'gemini_request_duration_ms',
  help: 'End-to-end request duration in milliseconds',
  labelNames: ['model'],
  buckets: [100, 250, 500, 1000, 2000, 3000, 5000, 10000, 20000],
  registers: [registry],
});

export const retriesTotal = new Counter({
  name: 'gemini_retries_total',
  help: 'Total retry attempts across all requests',
  labelNames: ['model'],
  registers: [registry],
});

// ─── Key metrics ─────────────────────────────────────────────────────────────

export const keyCooldownsTotal = new Counter({
  name: 'gemini_key_cooldowns_total',
  help: 'Total number of times a key was put into cooldown (429)',
  registers: [registry],
});

export const activeKeysGauge = new Gauge({
  name: 'gemini_active_keys',
  help: 'Number of API keys currently in the active pool',
  registers: [registry],
});

export const cooldownKeysGauge = new Gauge({
  name: 'gemini_cooldown_keys',
  help: 'Number of API keys currently in cooldown',
  registers: [registry],
});

// ─── Model metrics ───────────────────────────────────────────────────────────

export const model503Total = new Counter({
  name: 'gemini_model_503_total',
  help: 'Total 503 (overload) responses per model',
  labelNames: ['model'],
  registers: [registry],
});

export const modelTimeoutsTotal = new Counter({
  name: 'gemini_model_timeouts_total',
  help: 'Total timeout errors per model',
  labelNames: ['model'],
  registers: [registry],
});

// ─── Queue metrics ────────────────────────────────────────────────────────────

export const queueSizeGauge = new Gauge({
  name: 'gemini_queue_size',
  help: 'Number of jobs in each queue state',
  labelNames: ['state'],
  registers: [registry],
});

export const workerActiveGauge = new Gauge({
  name: 'gemini_worker_active_jobs',
  help: 'Number of jobs currently being processed by workers',
  registers: [registry],
});

export const queueWaitDuration = new Histogram({
  name: 'gemini_queue_wait_ms',
  help: 'Time spent in queue before processing starts',
  buckets: [100, 500, 1000, 2500, 5000, 10000, 30000, 60000],
  registers: [registry],
});

export const batchCompletionDuration = new Histogram({
  name: 'gemini_batch_completion_ms',
  help: 'Total time to complete an entire batch of jobs',
  buckets: [1000, 5000, 15000, 30000, 60000, 120000, 300000],
  registers: [registry],
});

// ─── Hivemind metrics ────────────────────────────────────────────────────────

export const hivemindEmbeddingsTotal = new Counter({
  name: 'hivemind_embeddings_total',
  help: 'Total embedding API calls made for hivemind (hidden cost from user perspective)',
  labelNames: ['operation', 'status'], // operation: retrieve|store, status: success|failure|timeout
  registers: [registry],
});

/**
 * Extract summary statistics (Avg, P50, P90, P99) from a Histogram.
 * Since we don't have a real PromQL engine, we compute approximate percentiles
 * based on the buckets or just return count/sum/max for now.
 */
export async function getMetricSummary(histogramName) {
  const metrics = await registry.getMetricsAsJSON();
  const h = metrics.find(m => m.name === histogramName);
  if (!h || !h.values) return null;

  // Find the 'sum' and 'count' samples
  const sumVal = h.values.find(v => v.metricName === `${histogramName}_sum`)?.value || 0;
  const countVal = h.values.find(v => v.metricName === `${histogramName}_count`)?.value || 0;
  
  // Basic average
  const avg = countVal > 0 ? Math.round(sumVal / countVal) : 0;

  // Approximate P95 by looking at buckets (simplified: find the bucket where 95% of count is)
  const buckets = h.values.filter(v => v.metricName === `${histogramName}_bucket`).sort((a,b) => a.labels.le - b.labels.le);
  let p95 = 0;
  if (countVal > 0) {
    const target = countVal * 0.95;
    const bucket = buckets.find(b => b.value >= target);
    p95 = bucket ? bucket.labels.le : (buckets[buckets.length-1]?.labels?.le || 0);
  }

  return { avg, p95, count: countVal };
}
