import { describe, it, expect, vi } from 'vitest';

vi.mock('prom-client', () => {
  class MockCounter {
    constructor(opts) { this.name = opts.name; }
    inc() {}
  }
  class MockHistogram {
    constructor(opts) { this.name = opts.name; }
    observe() {}
  }
  class MockGauge {
    constructor(opts) { this.name = opts.name; }
    set() {}
  }
  class MockRegistry {
    registerMetric() {}
    getMetricsAsJSON() { return Promise.resolve([]); }
  }
  return {
    Registry: MockRegistry,
    Counter: MockCounter,
    Histogram: MockHistogram,
    Gauge: MockGauge,
    collectDefaultMetrics: vi.fn(),
  };
});

import {
  registry, requestsTotal, requestDuration, retriesTotal,
  keyCooldownsTotal, model503Total, modelTimeoutsTotal,
  activeKeysGauge, cooldownKeysGauge, queueSizeGauge,
  workerActiveGauge, queueWaitDuration, batchCompletionDuration,
} from '../../src/metrics/index.js';

describe('metrics', () => {
  it('should export registry', () => {
    expect(registry).toBeDefined();
  });

  it('should export requestsTotal counter', () => {
    expect(requestsTotal).toBeDefined();
    expect(requestsTotal.name).toBe('gemini_requests_total');
  });

  it('should export requestDuration histogram', () => {
    expect(requestDuration).toBeDefined();
    expect(requestDuration.name).toBe('gemini_request_duration_ms');
  });

  it('should export activeKeysGauge', () => {
    expect(activeKeysGauge).toBeDefined();
  });

  it('should export queueSizeGauge', () => {
    expect(queueSizeGauge).toBeDefined();
  });

  it('should export all metric instances without error', () => {
    expect(retriesTotal).toBeDefined();
    expect(keyCooldownsTotal).toBeDefined();
    expect(model503Total).toBeDefined();
    expect(modelTimeoutsTotal).toBeDefined();
    expect(cooldownKeysGauge).toBeDefined();
    expect(workerActiveGauge).toBeDefined();
    expect(queueWaitDuration).toBeDefined();
    expect(batchCompletionDuration).toBeDefined();
  });
});
