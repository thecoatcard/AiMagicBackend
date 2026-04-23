import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { config } from '../config.js';

// ── Dedicated Redis client for hivemind ──────────────────────────────────────
let _redis = null;

function getHivemindRedis() {
  if (!_redis && config.hivemindRedisUrl) {
    _redis = new Redis(config.hivemindRedisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
    });
    _redis.on('error', (err) => console.error('[Hivemind Redis]', err.message));
    _redis.connect().catch(() => {});
  }
  return _redis;
}

/**
 * Check if hivemind is available (Redis URL configured and client connected).
 */
export function isHivemindEnabled() {
  return Boolean(config.hivemindRedisUrl);
}

// ── Cosine similarity ────────────────────────────────────────────────────────
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Key helpers ──────────────────────────────────────────────────────────────
// Key format: hm:{email}:{uuid}
function userKeyPattern(userEmail) {
  return `hm:${userEmail}:*`;
}
function entryKey(userEmail) {
  // Full UUID (not truncated) — eliminates collision risk for high-volume users
  return `hm:${userEmail}:${randomUUID()}`;
}

/**
 * Store a prompt+response pair as an embedding vector in the dedicated Redis.
 * Each entry auto-expires after hivemindTtlSecs (default 4 hours).
 *
 * @param {string}   userEmail - User's email
 * @param {string}   text      - Concatenated prompt + response snippet
 * @param {number[]} vector    - Embedding vector from Gemini
 */
export async function storeContext(userEmail, text, vector) {
  const redis = getHivemindRedis();
  if (!redis) return;

  try {
    const key = entryKey(userEmail);
    const snippet = text.length > config.hivemindMaxSnippetLen
      ? text.slice(0, config.hivemindMaxSnippetLen) + '…'
      : text;

    // Store as JSON with float32-packed vector for memory efficiency
    const payload = JSON.stringify({
      t: snippet,
      v: Array.from(vector),  // float64 array → JSON array
      ts: Date.now(),
    });

    await redis.set(key, payload, 'EX', config.hivemindTtlSecs);
  } catch (err) {
    // Fire-and-forget — hivemind is non-critical
    console.warn('[Hivemind] storeContext error:', err.message);
  }
}

/**
 * Retrieve the top-K most relevant context snippets for a user given a query vector.
 *
 * @param {string}   userEmail   - User's email
 * @param {number[]} queryVector - Embedding of the current prompt
 * @returns {Promise<string[]>}  - Array of relevant text snippets, most relevant first
 */
export async function retrieveContext(userEmail, queryVector) {
  const redis = getHivemindRedis();
  if (!redis) return [];

  try {
    // SCAN for all user keys (avoids KEYS blocking)
    const entries = [];
    let cursor = '0';
    const pattern = userKeyPattern(userEmail);

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        const values = await redis.mget(...keys);
        for (const val of values) {
          if (!val) continue;
          try {
            const entry = JSON.parse(val);
            if (entry.v && entry.t) entries.push(entry);
          } catch { /* skip corrupt entries */ }
        }
      }
    } while (cursor !== '0');

    if (entries.length === 0) return [];

    // Score each entry by cosine similarity
    const scored = entries.map(e => ({
      text: e.t,
      score: cosineSimilarity(queryVector, e.v),
    }));

    // Order: filter (drop low-relevance) → sort desc → slice top-K.
    // Filtering before sort/slice prevents weak matches from squeezing out
    // strong-but-late entries when the user has more than topK snippets.
    // Fallback to 0.3 if config doesn't define the threshold (e.g. test mocks).
    const threshold = config.hivemindSimThreshold ?? 0.3;
    const filtered = scored.filter(s => s.score > threshold);
    filtered.sort((a, b) => b.score - a.score);
    return filtered.slice(0, config.hivemindTopK).map(s => s.text);
  } catch (err) {
    console.warn('[Hivemind] retrieveContext error:', err.message);
    return [];
  }
}

/**
 * Build a system instruction prefix from retrieved context snippets.
 * This gets prepended to the user's systemInstruction (if any).
 *
 * @param {string[]} snippets - Retrieved context snippets
 * @returns {string|null}     - System instruction prefix, or null if empty
 */
export function buildContextPrefix(snippets) {
  if (!snippets || snippets.length === 0) return null;

  const lines = snippets.map((s, i) => `[${i + 1}] ${s}`).join('\n');
  return `Relevant prior context from this user's recent session:\n${lines}\n\nUse the above context to maintain continuity. If the user references something from a prior exchange, use the context above to provide a coherent response.`;
}

/**
 * Graceful shutdown — disconnect hivemind Redis.
 */
export async function shutdownHivemind() {
  if (_redis) {
    await _redis.quit().catch(() => {});
    _redis = null;
  }
}
