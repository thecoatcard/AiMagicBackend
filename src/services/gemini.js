import { Pool } from 'undici';
import { config } from '../config.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

// Shared connection pool — reuses TCP connections across requests
const pool = new Pool(GEMINI_BASE, {
  connections: 100, // Increased for higher concurrency
  pipelining: 0,
});

/**
 * Call the Gemini generateContent API.
 *
 * @param {string} key     - API key
 * @param {string} model   - e.g. "gemini-2.5-flash"
 * @param {string} prompt  - user prompt text
 * @param {object} options - optional overrides (temperature, maxOutputTokens, etc.)
 * @returns {{ status: number, data: object, latencyMs: number }}
 * @throws {{ code: 'TIMEOUT' }} on request timeout
 */
export async function generateContent(key, model, prompt, options = {}) {
  const body = buildRequestBody(prompt, options);
  const start = Date.now();

  let statusCode, resBody;
  try {
    ({ statusCode, body: resBody } = await pool.request({
      method: 'POST',
      path: `/v1beta/models/${model}:generateContent`,
      headers: { 
        'content-type': 'application/json',
        'x-goog-api-key': key 
      },
      body,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    }));
  } catch (err) {
    if (isTimeoutError(err)) {
      const timeoutErr = new Error('Request timed out');
      timeoutErr.code = 'TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  }

  try {
    const rawData = await resBody.json();
    return { status: statusCode, data: rawData, latencyMs: Date.now() - start };
  } catch {
    // Non-JSON upstream response — ensure body is drained before returning
    await resBody.dump();
    return { status: statusCode, data: {}, latencyMs: Date.now() - start };
  }
}

/**
 * Call the Gemini streamGenerateContent API.
 * Returns the raw undici body stream — caller is responsible for piping/consuming it.
 *
 * @returns {{ status: number, bodyStream: Readable }}
 * @throws {{ code: 'TIMEOUT' }} on timeout
 */
export async function streamGenerateContent(key, model, prompt, options = {}) {
  const body = buildRequestBody(prompt, options);

  let statusCode, bodyStream;
  try {
    ({ statusCode, body: bodyStream } = await pool.request({
      method: 'POST',
      path: `/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      headers: { 
        'content-type': 'application/json',
        'x-goog-api-key': key
      },
      body,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    }));
  } catch (err) {
    if (isTimeoutError(err)) {
      const timeoutErr = new Error('Request timed out');
      timeoutErr.code = 'TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  }

  return { status: statusCode, bodyStream };
}

/**
 * Build the Gemini API request body.
 *
 * Supports:
 *   - Text-only, image-only, or mixed (multimodal) prompts
 *   - System instruction:  options.systemInstruction  (string)
 *   - Conversation history: options.history           (Array<{ role, text }>)
 *   - Thinking budget:      options.thinkingBudget    (integer 0–24576)
 *
 * options.images = Array of:
 *   { type: 'base64', mimeType: 'image/jpeg', data: '<base64-string>' }
 *   { type: 'url',    mimeType: 'image/jpeg', url:  'https://...'    }
 */
function buildRequestBody(prompt, options = {}) {
  // ── Build the current user turn ────────────────────────────────────────────
  const parts = [];

  if (prompt && prompt.length > 0) {
    parts.push({ text: prompt });
  }

  for (const img of options.images ?? []) {
    if (img.type === 'url') {
      parts.push({ fileData: { mimeType: img.mimeType, fileUri: img.url } });
    } else {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
  }

  if (parts.length === 0) {
    throw new Error('Request must contain at least one text or image part');
  }

  // ── Assemble contents: prior history turns + current user turn ─────────────
  const contents = [];
  for (const turn of options.history ?? []) {
    contents.push({ role: turn.role, parts: [{ text: turn.text }] });
  }
  contents.push({ role: 'user', parts });

  // ── Build the final body ───────────────────────────────────────────────────
  const generationConfig = {
    temperature:     options.temperature     ?? 1,
    maxOutputTokens: options.maxOutputTokens ?? 8192,
    ...options.generationConfig,
  };

  // Thinking budget — supported by gemini-2.5-flash, gemini-2.5-pro, etc.
  // Set to 0 to disable thinking; omit to use the model default.
  if (options.thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget };
  }

  const body = { contents, generationConfig };

  // System instruction — sets model persona/behavior before any user turn
  if (options.systemInstruction) {
    body.systemInstruction = { parts: [{ text: options.systemInstruction }] };
  }

  return JSON.stringify(body);
}

function isTimeoutError(err) {
  return (
    err.name === 'AbortError' ||
    err.name === 'TimeoutError' ||
    err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    err.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    err.code === 'UND_ERR_BODY_TIMEOUT'
  );
}
