import { getDb } from './client.js';

// Rate-limit error logging to once per 30s to avoid console flooding on MongoDB outage
let _lastLogErrorTime = 0;
const LOG_ERROR_INTERVAL_MS = 30_000;

function fireAndForget(promise) {
  promise.catch((err) => {
    const now = Date.now();
    if (now - _lastLogErrorTime > LOG_ERROR_INTERVAL_MS) {
      _lastLogErrorTime = now;
      console.error('[MongoDB] log write failed:', err.message);
    }
  });
}

/**
 * Log a completed generation request.
 *
 * @param {object} entry
 * @param {string} entry.request_id
 * @param {string} entry.model
 * @param {string} entry.api_key_masked
 * @param {number} entry.latency_ms
 * @param {'success'|'error'|'exhausted'} entry.status
 * @param {number} entry.retries
 * @param {number} entry.prompt_length
 * @param {object} [entry.usage_metadata]
 */
export function logRequest(entry) {
  fireAndForget(
    getDb().then(db =>
      db.collection('requests').insertOne({
        ...entry,
        created_at: new Date(),
      })
    )
  );
}

/**
 * Log an error event (429, 503, timeout, etc.).
 *
 * @param {object} entry
 * @param {string} entry.type      e.g. '429', '503', 'timeout', 'other'
 * @param {string} entry.model
 * @param {string} entry.key_masked
 * @param {string} [entry.message]
 */
export function logError(entry) {
  fireAndForget(
    getDb().then(db =>
      db.collection('errors').insertOne({
        ...entry,
        timestamp: new Date(),
      })
    )
  );
}
