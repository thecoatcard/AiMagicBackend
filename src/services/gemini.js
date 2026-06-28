import { Pool } from 'undici';
import { config } from '../config.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

// Shared connection pool — reuses TCP connections across requests
const pool = new Pool(GEMINI_BASE, {
  connections: 100, // Increased for higher concurrency
  pipelining: 0,
  headersTimeout: config.requestTimeoutMs,
  bodyTimeout: config.requestTimeoutMs,
});

/**
 * Call the Gemini generateContent API.
 *
 * @param {string} key     - API key
 * @param {string} model   - e.g. "gemini-3.1-flash-lite-preview"
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
    await resBody.dump().catch(() => {});
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
 * Call the Gemini embedContent API.
 *
 * @param {string} key    - API key
 * @param {string} model  - e.g. "gemini-embedding-2-preview"
 * @param {string} text   - text to embed
 * @returns {{ status: number, data: object, latencyMs: number }}
 * @throws {{ code: 'TIMEOUT' }} on request timeout
 */
export async function embedContent(key, model, text) {
  const start = Date.now();
  const body = JSON.stringify({
    content: { parts: [{ text }] }
  });

  let statusCode, resBody;
  try {
    ({ statusCode, body: resBody } = await pool.request({
      method: 'POST',
      path: `/v1beta/models/${model}:embedContent`,
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
    await resBody.dump();
    return { status: statusCode, data: {}, latencyMs: Date.now() - start };
  }
}

/**
 * Call the Gemini batchEmbedContents API.
 *
 * @param {string}   key    - API key
 * @param {string}   model  - e.g. "gemini-embedding-2-preview"
 * @param {string[]} texts  - array of texts to embed
 * @returns {{ status: number, data: object, latencyMs: number }}
 * @throws {{ code: 'TIMEOUT' }} on request timeout
 */
export async function batchEmbedContents(key, model, texts) {
  const start = Date.now();
  // Note: some models require "models/" prefix in the inner request
  const requests = texts.map(text => ({
    model: model.startsWith('models/') ? model : `models/${model}`,
    content: { parts: [{ text }] }
  }));
  const body = JSON.stringify({ requests });

  let statusCode, resBody;
  try {
    ({ statusCode, body: resBody } = await pool.request({
      method: 'POST',
      path: `/v1beta/models/${model}:batchEmbedContents`,
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
    await resBody.dump();
    return { status: statusCode, data: {}, latencyMs: Date.now() - start };
  }
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
/**
 * Call Gemini generateContent with image output modality.
 * Uses the standard generateContent endpoint with responseModalities: ["IMAGE", "TEXT"].
 *
 * @param {string} key     - API key
 * @param {string} model   - e.g. "gemini-2.0-flash-exp"
 * @param {string} prompt  - text prompt for image generation
 * @param {object} options - { aspectRatio }
 * @returns {{ status: number, data: object, latencyMs: number }}
 */
export async function generateImage(key, model, prompt, options = {}) {
  const start = Date.now();
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
    },
  });

  let statusCode, resBody;
  try {
    ({ statusCode, body: resBody } = await pool.request({
      method: 'POST',
      path: `/v1beta/models/${model}:generateContent`,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key,
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
    await resBody.dump().catch(() => {});
    return { status: statusCode, data: {}, latencyMs: Date.now() - start };
  }
}

function buildRequestBody(prompt, options = {}) {
  // ── Build the current user turn ────────────────────────────────────────────
  let parts = [];

  if (options.parts && options.parts.length > 0) {
    parts = options.parts;
  } else {
    if (prompt && prompt.length > 0) {
      parts.push({ text: prompt });
    }

    // File attachments (PDF/video as inline binary, Excel/CSV as extracted text)
    for (const file of options.files ?? []) {
      if (file.type === 'inlineData') {
        parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
      } else if (file.type === 'text') {
        parts.push({ text: file.text });
      }
    }

    for (const img of options.images ?? []) {
      if (img.type === 'url') {
        parts.push({ fileData: { mimeType: img.mimeType, fileUri: img.url } });
      } else {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      }
    }
  }

  if (parts.length === 0) {
    throw new Error('Request must contain at least one text, image, file, or parts entry');
  }

  // ── Assemble contents: prior history turns + current user turn ─────────────
  const contents = [];
  for (const turn of options.history ?? []) {
    if (turn.parts && turn.parts.length > 0) {
      contents.push({ role: turn.role, parts: turn.parts });
    } else {
      contents.push({ role: turn.role, parts: [{ text: turn.text || '' }] });
    }
  }
  contents.push({ role: 'user', parts });

  // ── Build the final body ───────────────────────────────────────────────────
  const generationConfig = {
    temperature:     options.temperature     ?? 1,
    maxOutputTokens: options.maxOutputTokens,
    ...options.generationConfig,
  };

  if (options.responseModalities !== undefined) {
    generationConfig.responseModalities = options.responseModalities;
  }
  if (options.speechConfig !== undefined) {
    generationConfig.speechConfig = options.speechConfig;
  }

  // Thinking budget — supported by gemini-2.5-flash, gemini-2.5-pro, etc.
  // Set to 0 to disable thinking; omit to use the model default.
  if (options.thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget };
  }

  const body = { contents, generationConfig };

  if (options.tools !== undefined) {
    body.tools = options.tools;
  }
  if (options.toolConfig !== undefined) {
    body.toolConfig = options.toolConfig;
  }

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
