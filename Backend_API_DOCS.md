# Coatcard AiMagic API — Developer Guide

**Base URL:** `http://localhost:3000` (development) · `https://aimagicbackend.onrender.com` (production)  
**Content-Type:** `application/json` for all requests and responses (except `/v1/metrics` and `/v1/generate/stream`)

---

## Table of Contents

1. [Authentication Overview](#1-authentication-overview)
2. [Auth Endpoints](#2-auth-endpoints)
3. [Making Authenticated Requests](#3-making-authenticated-requests)
4. [Roles & Access Control](#4-roles--access-control)
5. [AI Generation Endpoints](#5-ai-generation-endpoints)
6. [Embeddings](#6-embeddings)
7. [Streaming](#7-streaming)
8. [Batch Processing](#8-batch-processing)
9. [User Management](#9-user-management)
10. [Support Tickets](#10-support-tickets)
11. [Tools Marketplace](#11-tools-marketplace)
12. [Analytics & Logs](#12-analytics--logs)
13. [Admin — Key Management](#13-admin--key-management)
14. [Admin — Model Config & Health](#14-admin--model-config--health)
15. [Admin — Queue Management](#15-admin--queue-management)
16. [Admin — System Control](#16-admin--system-control)
17. [Admin — Alerts & Notifications](#17-admin--alerts--notifications)
18. [Admin — Health Dashboard](#18-admin--health-dashboard)
19. [Admin — Audit Log](#19-admin--audit-log)
20. [Payment & System Info Routes](#20-payment--system-info-routes)
21. [Infrastructure](#21-infrastructure)
22. [Error Reference](#22-error-reference)
23. [Full Flow Examples](#23-full-flow-examples)
24. [Tester Use Cases & Verification](#24-tester-use-cases--verification)

---

## 1. Authentication Overview

All `/v1/*` endpoints require a valid JWT token sent in the `Authorization` header (or as `?token=<JWT>` query parameter).

The login flow is **two-step** and uses email OTP (One-Time Password):

```
Step 1:  POST /auth/login   →  OTP sent to your email
Step 2:  POST /auth/verify  →  OTP verified  →  JWT token returned
Step 3:  Use token in Authorization: Bearer <token> for all /v1/* calls
Step 4:  POST /auth/logout  →  Session invalidated
```

### Single-Device Enforcement

Only **one active session per email** is allowed at any time.  
If you log in on Device B while Device A is already logged in:
- Device A's token is **immediately invalidated**
- Device A receives an email notification
- Device A gets `401 session_superseded` on its next request

---

## 2. Auth Endpoints

### `POST /auth/login`

Send a 6-digit OTP to the given email.

**No authentication required.**

**Request:**
```json
{
  "email": "user@example.com"
}
```

**Success `200`:**
```json
{
  "message": "OTP sent to your email. It expires in 10 minutes."
}
```

**Error `503`** (sign-ins temporarily disabled by admin):
```json
{
  "error": "New sign-ins are temporarily disabled by the administrator.",
  "code":  "REGISTRATION_DISABLED"
}
```

**Error `403`** (email not on whitelist):
```json
{
  "error": "This email address is not authorised to access this service.",
  "code":  "NOT_WHITELISTED"
}
```

**Error `502`** (email delivery failed):
```json
{
  "error": "Failed to send OTP email",
  "code":  "EMAIL_ERROR"
}
```

**Frontend notes:**
- The OTP is valid for **10 minutes**
- After **5 wrong attempts**, the OTP is locked — user must call `/auth/login` again
- Calling `/auth/login` again before the OTP expires generates a fresh OTP and resets the attempt counter
- If the whitelist is configured by the admin, only allowed emails/domains can sign in

---

### `POST /auth/verify`

Verify the OTP and receive a JWT token.

**No authentication required.**

**Request:**
```json
{
  "email": "user@example.com",
  "otp":   "481920"
}
```

> `otp` must be exactly 6 **digits** (string matching `^[0-9]{6}$`)

**Success `200`:**
```json
{
  "token":   "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "message": "Logged in successfully."
}
```

If another session was active (different device):
```json
{
  "token":   "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "message": "Logged in. Previous session on another device has been invalidated."
}
```

**Error `401`:**
```json
{
  "error": "invalid_otp",
  "code":  "OTP_INVALID"
}
```

Possible `error` values:

| Value | Meaning |
|---|---|
| `invalid_otp` | Wrong OTP entered |
| `otp_expired_or_not_found` | OTP expired or never requested |
| `too_many_attempts` | 5 failed attempts — request a new OTP |

**Frontend notes:**
- Store the `token` in `localStorage` or a secure cookie
- The token expires in **7 days** by default
- The JWT payload contains `{ email, role }` — decode it on the frontend to read the user's role

---

### `POST /auth/logout`

Invalidates the current session. Token is no longer usable after this.

**Authentication required.**

**Request:** No body needed.

**Success `200`:**
```json
{
  "message": "Logged out successfully."
}
```

---

### `GET /auth/me`

Returns the currently authenticated user's email and role.

**Authentication required.**

**Success `200`:**
```json
{
  "email": "user@example.com",
  "role":  "user"
}
```

---

## 3. Making Authenticated Requests

Every `/v1/*` request must include:

```
Authorization: Bearer <your-jwt-token>
Content-Type: application/json
```

Alternatively, the JWT can be passed as a query parameter: `?token=<your-jwt-token>`

### JavaScript Fetch Example

```js
const token = localStorage.getItem('auth_token');

const res = await fetch('http://localhost:3000/v1/generate', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({ prompt: 'Hello!' }),
});

if (res.status === 401) {
  // Token expired or session invalidated — redirect to login
  localStorage.removeItem('auth_token');
  window.location.href = '/login';
}

const data = await res.json();
```

### Axios Interceptor Pattern

```js
import axios from 'axios';

const api = axios.create({ baseURL: 'http://localhost:3000' });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('auth_token');
      window.location.href = '/login';
    }
    if (err.response?.status === 403 && err.response.data?.code === 'ACCOUNT_BLOCKED') {
      window.location.href = '/blocked';
    }
    if (err.response?.status === 503 && err.response.data?.code === 'MAINTENANCE_MODE') {
      window.location.href = '/maintenance';
    }
    return Promise.reject(err);
  }
);
```

### When You Get a 401

| `error` value | What to do |
|---|---|
| `Missing or malformed Authorization header` | Token missing — send to login |
| `token_expired` | JWT expired — send to login |
| `invalid_token` | Token corrupted — send to login |
| `session_not_found` | User logged out elsewhere — send to login |
| `session_superseded` | Logged in on another device — show notification and send to login |

### When You Get a 403

| `code` | What happened |
|---|---|
| `ACCOUNT_BLOCKED` | Admin blocked your account |
| `FORBIDDEN` | You don't have the required role for this endpoint |
| `IMPERSONATION_READ_ONLY` | Impersonated sessions cannot make write requests (POST/PUT/PATCH/DELETE) |

### When You Get a 503

| `code` | What happened |
|---|---|
| `MAINTENANCE_MODE` | System is in maintenance — check back soon |
| `GENERATION_DISABLED` | AI generation is turned off by admin |
| `REGISTRATION_DISABLED` | New sign-ins are paused by admin |

---

## 4. Roles & Access Control

### Roles

Every user has one of three roles:

| Role | What they can do |
|---|---|
| `user` | Generate content, stream, batch, embeddings, view own logs/usage, manage own tickets, browse tools |
| `admin` | Everything a user can do, plus: manage users, tickets (admin actions), set plans, view user stats |
| `owner` | Everything an admin can do, plus: manage API keys, model config, queue, metrics, debug tools, system settings, alerts, health dashboard, audit log, whitelist, promote/demote users, impersonate users. Cannot be blocked, deleted, or demoted via the API |

> The owner account is set via `OWNER_EMAIL` in `.env` and is seeded to the database on every server startup.

### Plans (Daily Quota)

Every `user`-role account has a plan controlling their **daily request quota**:

| Plan | Default daily limit | Description |
|---|---|---|
| `free` | 5 requests / day | Default for all new accounts |
| `premium` | 500 requests / day | Upgraded by admin |

- Plan limits are **admin-configurable** via `PATCH /v1/admin/system/plan-limits` without restarting the server.
- Admins and owners have **no daily limit**.
- The daily window resets ~24 hours after the first request of each window (rolling, not midnight).
- Batch requests count **per prompt** — a batch of 10 prompts uses 10 of your quota.
- Admin can set a custom `max_requests_per_day` override via `PATCH /v1/users/:email/limits` which takes precedence over the plan default.

### Rate Limits

All users have a **per-minute limit** (default 60/min, admin-configurable globally).  
Admins and owners are never rate-limited.

**Daily quota exceeded:**
```json
{
  "error": "Daily quota exceeded: max 5 requests per day (free plan)",
  "code": "DAILY_LIMIT_EXCEEDED",
  "limit": 5,
  "reset_in_seconds": 38400
}
```

**Per-minute rate limit exceeded:**
```json
{
  "error": "Rate limit exceeded: max 60 requests per minute",
  "code": "RATE_LIMIT_EXCEEDED",
  "reset_in_seconds": 42
}
```

### Role Change Behaviour

When a user's role is changed by the owner, their **session is immediately invalidated** — they must log in again to receive the new role in their token.

---

## 5. AI Generation Endpoints

### `POST /v1/generate`

Send a prompt (text + optional images) and get a full response back (non-streaming).

Supports **system instructions**, **conversation history**, **multimodal images**, and **thinking models**.

**Authentication required. Rate-limited.**

---

#### Request fields

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | ❌ * | The user's input text |
| `images` | array | ❌ * | Image parts (see below). Required if no prompt |
| `files` | array | ❌ | Document parts (PDF, Excel, CSV). Max 5 per request |
| `model` | string | ❌ | Override model. Defaults to best available |
| `temperature` | number (0–2) | ❌ | Creativity. Default: 1 |
| `maxOutputTokens` | integer | ❌ | Max response length. Default: 8192 |
| `systemInstruction` | string (1–8192 chars) | ❌ | Sets the model's persona or behavior before any user turn |
| `history` | array | ❌ | Prior conversation turns for multi-turn chat |
| `thinkingBudget` | integer (0–24576) | ❌ | Token budget for model reasoning. `0` disables thinking |

> \* At least one of `prompt` or `images` must be provided.
>
> `files[]` accepts base64-encoded PDF, Excel (`.xlsx`/`.xls`), or CSV documents.
> Each entry must include `mimeType`, `data` (base64), and `name`. Maximum **5 files** per request.

---

#### Text-only request
```json
{
  "prompt":          "Explain quantum computing in simple terms",
  "model":           "gemini-2.5-flash",
  "temperature":     0.7,
  "maxOutputTokens": 1024
}
```

#### With system instruction
```json
{
  "systemInstruction": "You are a helpful coding assistant. Always respond with working code examples.",
  "prompt": "How do I debounce a function in JavaScript?"
}
```

#### Multi-turn conversation (chat history)
```json
{
  "systemInstruction": "You are a friendly math tutor.",
  "history": [
    { "role": "user",  "text": "What is a derivative?" },
    { "role": "model", "text": "A derivative measures how a function changes..." },
    { "role": "user",  "text": "Can you give me a simple example?" },
    { "role": "model", "text": "Sure! If f(x) = x², then f'(x) = 2x..." }
  ],
  "prompt": "Now explain the chain rule."
}
```

> `history` must alternate between `user` and `model` roles and must end with a `model` turn. The current `prompt` is always the final user turn — do not include it in `history`.

#### With thinking model
```json
{
  "prompt":        "Solve: A train leaves Chicago at 60mph...",
  "model":         "gemini-2.5-pro",
  "thinkingBudget": 8192
}
```

> Set `thinkingBudget: 0` to disable thinking. Omit to use the model's default budget.

#### Image + text (multimodal)
```json
{
  "prompt": "What is written on this receipt? List each item and total.",
  "images": [
    {
      "type":     "base64",
      "mimeType": "image/jpeg",
      "data":     "/9j/4AAQSkZJRgABAQAA..."
    }
  ]
}
```

#### Image URL
```json
{
  "prompt": "Describe what you see.",
  "images": [{ "type": "url", "mimeType": "image/png", "url": "https://example.com/chart.png" }]
}
```

---

#### Image object fields

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"base64"` \| `"url"` | ❌ | Default: `"base64"` |
| `mimeType` | string | ✅ | `image/jpeg`, `image/png`, `image/gif`, `image/webp` |
| `data` | string | ✅ (base64) | Base64-encoded image bytes |
| `url` | string | ✅ (url) | Public HTTPS image URL |

- Maximum **16 images** per request
- Maximum total body size: **20 MB**
- Image URLs **must** use HTTPS

---

#### History object fields

| Field | Type | Required | Description |
|---|---|---|---|
| `role` | `"user"` \| `"model"` | ✅ | Who sent this message |
| `text` | string | ✅ | The message content |

- Maximum **200 turns** in history
- Must alternate `user` / `model` roles

---

#### Available models

Any valid Gemini model string is accepted. The default fallback chain (admin-configurable) is:

| Model | Notes |
|---|---|
| `gemini-3-flash-preview` | Primary — most capable, tried first |
| `gemini-2.5-flash` | Fast + smart, supports thinking |
| `gemini-2.5-flash-lite` | Lightweight |
| `gemini-3.1-flash-lite-preview` | Lightest fallback |

> If a user-specified model fails with a timeout or 503, the backend automatically falls back to the configured chain and continues retrying. The `model` field in the response shows which model actually generated the reply.

---

#### Success `200`

```json
{
  "text":       "The receipt shows: Coffee $4.50, Sandwich $8.75. Total: $13.25",
  "model":      "gemini-2.5-flash",
  "request_id": "a1b2c3d4-...",
  "retries":    0,
  "latency_ms": 1240,
  "usageMetadata": {
    "promptTokenCount":     266,
    "candidatesTokenCount": 38,
    "totalTokenCount":      304
  }
}
```

#### Error responses

| Status | `code` | Meaning |
|---|---|---|
| `400` | `BAD_REQUEST` | Missing prompt/images, invalid field, non-HTTPS image URL |
| `429` | `RATE_LIMIT_EXCEEDED` | Per-user rate limit reached |
| `429` | `DAILY_LIMIT_EXCEEDED` | Daily plan quota hit |
| `503` | `NO_KEYS` | All API keys are in cooldown |
| `503` | `POOL_EXHAUSTED` | Key pool completely exhausted (circuit breaker tripped) |
| `503` | `RETRIES_EXHAUSTED` | All retry attempts failed |
| `503` | `GENERATION_DISABLED` | Generation turned off by admin |
| `502` | `UPSTREAM_ERROR` | Network error reaching Gemini |

---

### Converting images to base64 (JavaScript)

```js
async function fileToBase64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(file);
  });
}

const file = document.getElementById('imageInput').files[0];
const base64 = await fileToBase64(file);

await fetch('/v1/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({
    prompt: 'What is in this image?',
    images: [{ type: 'base64', mimeType: file.type, data: base64 }],
  }),
});
```

---

## 6. Embeddings

### `POST /v1/embeddings`

Generate text embeddings using Gemini's embedding model.

**Authentication required. Rate-limited.**

#### Request fields

| Field | Type | Required | Description |
|---|---|---|---|
| `text` | string or string[] | ✅ | A single text string or an array of strings to embed |
| `model` | string | ❌ | Override model. Default: `gemini-embedding-2-preview` |

#### Single text request
```json
{
  "text": "What is machine learning?"
}
```

#### Batch embedding request
```json
{
  "text": [
    "What is machine learning?",
    "How does deep learning work?",
    "Explain neural networks"
  ]
}
```

#### Success `200`

```json
{
  "embedding": {
    "values": [0.0123, -0.0456, 0.0789]
  },
  "model":      "gemini-embedding-2-preview",
  "request_id": "a1b2c3d4-...",
  "retries":    0,
  "latency_ms": 320
}
```

For batch requests (array input), the response contains `embeddings` (array of embedding objects).

#### Error responses

| Status | `code` | Meaning |
|---|---|---|
| `400` | `BAD_REQUEST` | Missing or invalid `text` field |
| `429` | `RATE_LIMIT_EXCEEDED` | Per-user rate limit reached |
| `429` | `DAILY_LIMIT_EXCEEDED` | Daily plan quota hit |
| `503` | `NO_KEYS` | All API keys are in cooldown |
| `503` | `POOL_EXHAUSTED` | Key pool exhausted (circuit breaker) |
| `502` | `UPSTREAM_ERROR` | Network error reaching Gemini |

---

## 7. Streaming

### `POST /v1/generate/stream`

Same as `/v1/generate` but the response is streamed as **Server-Sent Events (SSE)**.

Supports all the same fields: `systemInstruction`, `history`, `images`, `files`, `thinkingBudget`, `model`, `temperature`, `maxOutputTokens`. The `files[]` array accepts up to 5 base64-encoded PDF/Excel/CSV documents (same shape as `/v1/generate`).

**Authentication required. Rate-limited.**

**Success response:**  
HTTP `200` with headers:
```
Content-Type:      text/event-stream
Cache-Control:     no-cache, no-transform
Connection:        keep-alive
X-Accel-Buffering: no
X-Request-Id:      <uuid>
X-Model-Used:      <model-name>
```

The body is a stream of SSE `data:` events. Each chunk is a partial Gemini JSON response.

**In-stream error** (if the stream breaks mid-generation):
```
data: {"error":"Stream interrupted","code":"STREAM_ERROR"}
```

### JavaScript Fetch (streaming)

```js
async function streamGenerate(prompt, { systemInstruction, history } = {}) {
  const res = await fetch('http://localhost:3000/v1/generate/stream', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${localStorage.getItem('auth_token')}`,
    },
    body: JSON.stringify({ prompt, systemInstruction, history }),
  });

  if (!res.ok) { console.error(await res.json()); return; }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return;
      try {
        const chunk = JSON.parse(raw);
        const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) process.stdout.write(text);
      } catch (_) {}
    }
  }
}
```

**Error responses** (JSON, not SSE — returned before streaming starts):

| Status | `code` | Meaning |
|---|---|---|
| `400` | `BAD_REQUEST` | Missing prompt/images or invalid field |
| `429` | `RATE_LIMIT_EXCEEDED` | Per-user rate limit reached |
| `429` | `DAILY_LIMIT_EXCEEDED` | Daily plan quota hit |
| `502` | `UPSTREAM_ERROR` | Network error |
| `503` | `NO_KEYS` | No keys available |
| `503` | `RETRIES_EXHAUSTED` | All retry attempts failed |
| `503` | `GENERATION_DISABLED` | Generation turned off by admin |

---

## 8. Batch Processing

Use this when you need to process many prompts asynchronously. Jobs are queued in BullMQ and processed by background workers.

> **Rate limiting:** Each prompt in the batch counts individually. Submitting 50 prompts uses 50 of your per-minute and per-day quota.

### Step 1 — Submit a batch

#### `POST /v1/generate/batch`

**Authentication required. Rate-limited (per-prompt).**

**Request:**
```json
{
  "prompts": [
    "Summarize this article: ...",
    "Translate to French: ...",
    "Write a haiku about cats"
  ],
  "model":       "gemini-2.5-flash",
  "temperature": 0.8
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `prompts` | string[] | ✅ | 1–100 items |
| `model` | string | ❌ | Optional override |
| `temperature` | number | ❌ | 0–2 |
| `maxOutputTokens` | integer | ❌ | >= 1 |

**Response `200`:**
```json
{
  "batch_id":   "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "total":      3,
  "jobs": [
    { "job_id": "aaa-...", "request_id": "bbb-...", "prompt_index": 0 },
    { "job_id": "ccc-...", "request_id": "ddd-...", "prompt_index": 1 },
    { "job_id": "eee-...", "request_id": "fff-...", "prompt_index": 2 }
  ],
  "status_url": "/v1/queue/batch/f47ac10b-..."
}
```

---

### Step 2 — Poll the whole batch

#### `GET /v1/queue/batch/:batchId`

**Authentication required. Owner only** (non-owners can view batches they submitted).

**Response `200`:**
```json
{
  "batch_id":  "f47ac10b-...",
  "total":     3,
  "completed": 2,
  "failed":    0,
  "pending":   1,
  "jobs": [
    { "job_id": "aaa-...", "prompt_index": 0, "state": "completed", "result": { "text": "..." } },
    { "job_id": "ccc-...", "prompt_index": 1, "state": "active" }
  ]
}
```

**Response `403`:** If a non-owner tries to view someone else's batch.  
**Response `404`:** Batch not found.

**Polling pattern:**
```js
async function pollBatch(batchId, onProgress) {
  while (true) {
    const { data } = await api.get(`/v1/queue/batch/${batchId}`);
    onProgress({ total: data.total, completed: data.completed, failed: data.failed });
    if (data.pending === 0) return data;
    await new Promise(r => setTimeout(r, 2000));
  }
}
```

---

## 9. User Management

### `GET /v1/users/me`

Get your own profile including role, status, plan, and rate limits.

**Authentication required. Any role.**

**Response `200`:**
```json
{
  "email":   "user@example.com",
  "role":    "user",
  "plan":    "free",
  "status":  "active",
  "limits": {
    "max_requests_per_min": 60
  },
  "usage": {
    "total_requests": 842
  },
  "created_at": "2025-06-01T10:00:00.000Z",
  "last_login":  "2025-06-10T14:22:11.000Z"
}
```

> `limits.max_requests_per_day` only appears when an admin has set a custom override. Otherwise the daily limit comes from `plan` — use `GET /v1/quota` for the live quota status.

---

### `GET /v1/quota`

Your real-time daily quota status.

**Authentication required. Any role.**

**Response `200`** (regular user):
```json
{
  "plan":             "free",
  "used_today":       3,
  "limit":            5,
  "remaining":        2,
  "reset_in_seconds": 38400,
  "plan_details":     { "label": "Free", "daily_requests": 5 }
}
```

**Response `200`** (admin / owner — no limit):
```json
{
  "plan":             "admin",
  "used_today":       0,
  "limit":            null,
  "remaining":        null,
  "reset_in_seconds": null
}
```

> `reset_in_seconds` counts down from the first request of each window, not from midnight.

---

### `GET /v1/users`

List all registered users with optional filtering and search.

**Authentication required. Admin or owner.**

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `50` | Max results (1–500) |
| `skip` | integer | `0` | Offset |
| `role` | string | — | Filter: `user`, `admin`, `owner` |
| `plan` | string | — | Filter: `free`, `premium` |
| `status` | string | — | Filter: `active`, `blocked` |
| `email` | string | — | Partial email search (case-insensitive) |
| `sort` | string | `created` | Sort by: `created`, `email`, `usage` |

**Response `200`:**
```json
{
  "total": 124,
  "users": [
    {
      "email":      "alice@example.com",
      "role":       "user",
      "plan":       "free",
      "status":     "active",
      "limits":     { "max_requests_per_min": 60 },
      "usage":      { "total_requests": 1200 },
      "created_at": "2025-06-01T10:00:00.000Z",
      "last_login": "2025-06-10T14:22:11.000Z"
    }
  ]
}
```

---

### `GET /v1/users/stats`

Aggregate metrics across all users.

**Authentication required. Admin or owner.**

**Response `200`:**
```json
{
  "total": 124,
  "by_role":   { "user": 120, "admin": 3, "owner": 1 },
  "by_plan":   { "free": 110, "premium": 14 },
  "by_status": { "active": 122, "blocked": 2 }
}
```

---

### `GET /v1/users/:email`

Get full detail for a specific user.

**Authentication required. Admin or owner.**

**`:email`** = URL-encoded email, e.g. `user%40example.com`

**Response `200`:** Same shape as one item from `/v1/users`.

**Response `404`:**
```json
{ "error": "User not found", "email": "user@example.com" }
```

---

### `POST /v1/users/bulk`

Perform a bulk operation on multiple users at once.

**Authentication required. Admin or owner.**

Cannot target yourself or the owner account — those emails are silently skipped.

**Request:**
```json
{
  "emails": ["alice@example.com", "bob@example.com"],
  "action": "block"
}
```

For `set_plan` action, also include `plan`:
```json
{
  "emails": ["alice@example.com", "bob@example.com"],
  "action": "set_plan",
  "plan":   "premium"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `emails` | string[] | ✅ | 1–100 email addresses |
| `action` | string | ✅ | `block`, `unblock`, `set_plan` |
| `plan` | string | ❌ | Required only for `set_plan`. Values: `free`, `premium` |

**Response `200`:**
```json
{
  "matched": 2,
  "modified": 2,
  "action": "block",
  "emails": ["alice@example.com", "bob@example.com"]
}
```

**Error `400`** (`MISSING_PLAN`): `set_plan` action without `plan` field.  
**Error `400`** (`NO_ELIGIBLE_USERS`): All target users were skipped.

---

### `POST /v1/users/:email/impersonate`

Create a short-lived read-only token to impersonate another user for debugging.

**Authentication required. Owner only.**

Cannot impersonate yourself.

**Response `200`:**
```json
{
  "token":        "eyJhbGci...",
  "expires_in":   "1h",
  "impersonating": "alice@example.com"
}
```

**Frontend notes:**
- The returned token works like a regular JWT but has `{ impersonated: true }` in its payload
- **Read-only** — `POST`, `PUT`, `PATCH`, `DELETE` requests made with this token return `403 IMPERSONATION_READ_ONLY`
- The impersonated user's real session is **not affected**
- Use this to inspect what a user sees without changing their data

---

### `PATCH /v1/users/:email/block`

Block a user. Their session is **immediately invalidated**.

**Authentication required. Admin or owner.**

Cannot block yourself or the owner account.

**Response `200`:**
```json
{ "updated": true, "email": "user@example.com", "status": "blocked" }
```

---

### `PATCH /v1/users/:email/unblock`

Unblock a previously blocked user.

**Authentication required. Admin or owner.**

**Response `200`:**
```json
{ "updated": true, "email": "user@example.com", "status": "active" }
```

---

### `PATCH /v1/users/:email/limits`

Set per-user rate limits. Takes effect immediately (Redis cache is invalidated).

**Authentication required. Admin or owner.**

**Request:**
```json
{
  "max_requests_per_min": 120,
  "max_requests_per_day": 50000
}
```

Either or both fields may be sent. No additional properties allowed.

**Response `200`:**
```json
{
  "updated": true,
  "email":   "user@example.com",
  "limits":  { "max_requests_per_min": 120, "max_requests_per_day": 50000 }
}
```

---

### `PATCH /v1/users/:email/role`

Promote or demote a user's role.

**Authentication required. Owner only.**

Cannot change your own role or the owner account's role.

**Request:**
```json
{ "role": "admin" }
```

Valid values: `"user"`, `"admin"` (cannot set `"owner"` via API)

> The affected user's session is **immediately invalidated** — they must log in again.

**Response `200`:**
```json
{ "updated": true, "email": "user@example.com", "role": "admin" }
```

---

### `PATCH /v1/users/:email/plan`

Upgrade or downgrade a user's plan. Takes effect immediately.  
Also clears any custom `max_requests_per_day` override so the plan limit becomes active.

**Authentication required. Admin or owner.**

**Request:**
```json
{ "plan": "premium" }
```

Valid values: `"free"`, `"premium"`

**Response `200`:**
```json
{ "updated": true, "email": "user@example.com", "plan": "premium", "premium_expires_at": "2026-05-21T..." }
```

---

### `DELETE /v1/users/:email`

Permanently delete a user account. Their session is invalidated immediately.

**Authentication required. Admin or owner.**

Cannot delete yourself or the owner account.

**Response `204`:** No content.

---

## 10. Support Tickets

Users can raise support tickets. Admins can view, search, and respond to all tickets.

**Ticket statuses:** `open` → `in_progress` → `resolved` / `closed`  
**Ticket priorities:** `low`, `medium` (default), `high`

---

### `POST /v1/tickets`

Create a new support ticket.

**Authentication required. Any role.**

**Request:** `multipart/form-data`

| Field | Type | Required | Constraints |
|---|---|---|---|
| `subject` | string | ✅ | 3–200 chars |
| `description` | string | ✅ | 10–5000 chars |
| `priority` | string | ❌ | `low`, `medium`, `high`. Default: `medium` |
| `screenshot` | file | ❌ | JPG, JPEG, PNG, WebP, or GIF format. Stored in GridFS. |

**Response `201`:**
```json
{
  "id":             "64f1a2b3c4d5e6f7a8b9c0d1",
  "user_email":     "user@example.com",
  "subject":        "Getting 503 errors frequently",
  "description":    "Since this morning...",
  "priority":       "high",
  "status":         "open",
  "admin_response": null,
  "admin_notes":    null,
  "created_at":     "2025-06-10T14:22:11.000Z",
  "updated_at":     "2025-06-10T14:22:11.000Z"
}
```

---

### `GET /v1/tickets/:id/screenshot`

Download or view the screenshot attached to a ticket.

**Authentication required.**

- **Users** can only view screenshots for their own tickets.
- **Admins/owner** can view any attachment.

**Response `200`:** The image file (binary stream with appropriate Content-Type).

**Response `403`:** Forbidden (not your ticket).  
**Response `404`:** Ticket not found or no screenshot attached.

---

### `GET /v1/tickets/stats`

Aggregate ticket counts broken down by status and priority.

**Authentication required. Admin or owner.**

**Response `200`:**
```json
{
  "total": 48,
  "by_status":   { "open": 12, "in_progress": 5, "resolved": 25, "closed": 6 },
  "by_priority": { "low": 10, "medium": 28, "high": 10 }
}
```

---

### `GET /v1/tickets`

List tickets.

- **Users** see only their own tickets.
- **Admins/owner** see all tickets, with additional filter options.

**Authentication required.**

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `status` | string | — | Filter: `open`, `in_progress`, `resolved`, `closed` |
| `priority` | string | — | Filter: `low`, `medium`, `high` |
| `limit` | integer | `50` | Max results (1–200) |
| `skip` | integer | `0` | Offset |
| `email` | string | — | **Admin only.** Filter by user email |
| `search` | string | — | **Admin only.** Full-text search in subject + description (max 100 chars) |
| `from` | ISO string | — | **Admin only.** Created on or after this date |
| `to` | ISO string | — | **Admin only.** Created on or before this date |

**Response `200`:**
```json
{
  "tickets": [
    {
      "id":             "64f1a2b3c4d5e6f7a8b9c0d1",
      "user_email":     "user@example.com",
      "subject":        "Getting 503 errors frequently",
      "priority":       "high",
      "status":         "open",
      "admin_response": null,
      "admin_notes":    null,
      "created_at":     "2025-06-10T14:22:11.000Z",
      "updated_at":     "2025-06-10T14:22:11.000Z"
    }
  ],
  "total": 12
}
```

---

### `GET /v1/tickets/:id`

Get a single ticket.

- Users can only view **their own** tickets.
- Admins/owner can view any ticket.

**Authentication required.**

**Response `200`:** Full ticket object (same shape as one item from `GET /v1/tickets`).

**Response `403`:**
```json
{ "error": "Forbidden", "code": "FORBIDDEN" }
```

---

### `PATCH /v1/tickets/:id`

Update ticket status, priority, add an admin response, or add internal notes.

**Authentication required. Admin or owner.**

**Request:**
```json
{
  "status":         "resolved",
  "admin_response": "We have increased your rate limits. Please retry your requests.",
  "priority":       "high",
  "admin_notes":    "User is on free plan — consider offering premium upgrade."
}
```

| Field | Type | Description |
|---|---|---|
| `status` | string | `open`, `in_progress`, `resolved`, `closed` |
| `admin_response` | string | Visible to the user (up to 5000 chars). Triggers an email notification |
| `priority` | string | `low`, `medium`, `high` |
| `admin_notes` | string | **Internal only** — not visible to the user (up to 2000 chars) |

At least one field is required. All fields are optional individually. No additional properties allowed.

**Response `200`:** Updated ticket object.

**Frontend notes:**
- Setting `admin_response` triggers an email to the user with the response text
- Setting `status` to `resolved` or `closed` (without a response) triggers a ticket-closed email to the user
- `admin_notes` is internal — it **never appears** in user-facing API responses or emails

---

### `POST /v1/tickets/bulk-close`

Bulk close or resolve multiple tickets at once.

**Authentication required. Admin or owner.**

**Request:**
```json
{
  "ids":    ["64f1...", "64f2...", "64f3..."],
  "status": "closed"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `ids` | string[] | ✅ | 1–100 ticket IDs |
| `status` | string | ✅ | `resolved` or `closed` |

No additional properties allowed.

**Response `200`:**
```json
{ "matched": 3, "modified": 3 }
```

---

### `DELETE /v1/tickets/:id`

Delete a ticket permanently.

**Authentication required. Owner only.**

**Response `204`:** No content.

---

## 11. Tools Marketplace

Tools are downloadable resources (ZIP files or external links) that admins publish for users to discover and download from within the platform. All authenticated users can browse the catalogue and download entries. Admins manage the full lifecycle: create, update, toggle visibility, and delete.

**Tool types:**

| `type` | How it works |
|---|---|
| `zip` | A `.zip` file uploaded directly to the server. Download streams the file. |
| `external` | An external URL. Download redirects the user there (`302`). |

---

### `GET /v1/tools`

List all tools. Regular users see only **active** tools. Admins and owners see all tools including inactive ones.

**Authentication required. Any role.**

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `50` | Max results (1–200) |
| `skip` | integer | `0` | Offset |
| `tag` | string | — | Filter by tag |

**Response `200`:**
```json
{
  "total": 6,
  "items": [
    {
      "id":             "64f1a2b3c4d5e6f7a8b9c0d1",
      "name":           "CSV Formatter",
      "description":    "Formats raw CSV data into clean, styled tables.",
      "icon":           "data:image/png;base64,iVBORw...",
      "type":           "zip",
      "file_name":      "csv-formatter-v1.2.zip",
      "file_size":      204800,
      "external_url":   null,
      "version":        "1.2",
      "tags":           ["csv", "formatting"],
      "download_count": 42,
      "is_active":      true,
      "created_by":     "admin@example.com",
      "created_at":     "2025-06-01T10:00:00.000Z",
      "updated_at":     "2025-06-05T14:00:00.000Z"
    }
  ]
}
```

> `icon` is either a base64 data URL (`data:image/png;base64,...`) or an external image URL. It is `null` if no icon was provided.  
> The server-side `file_path` is never exposed — only `file_name` and `file_size` are returned.

---

### `GET /v1/tools/:id`

Get a single tool's full details.

**Authentication required. Any role.**

Regular users cannot view inactive tools — they receive `404` as if the tool does not exist.

**Response `200`:** Full tool object (same shape as one item from `GET /v1/tools`).

**Response `404`:**
```json
{ "error": "Tool not found", "id": "64f1a2b3c4d5e6f7a8b9c0d1" }
```

---

### `GET /v1/tools/:id/download`

Download a tool. The `download_count` is incremented on **every** call.

**Authentication required. Any role.**

Non-admin users cannot download inactive tools.

Behaviour depends on the tool's `type`:

| `type` | Behaviour |
|---|---|
| `zip` | Streams the ZIP file as a binary download with `Content-Disposition: attachment`. |
| `external` | Returns `302 Redirect` to the configured `external_url`. |

**Response headers (zip type):**
```
Content-Type:        application/zip
Content-Disposition: attachment; filename="csv-formatter-v1.2.zip"
Content-Length:      204800
```

**Error `404`:**
```json
{ "error": "Tool not found", "id": "..." }
```

**Error `404`** (file missing on server disk):
```json
{ "error": "Tool file not found on server", "code": "FILE_NOT_FOUND" }
```

**Error `502`** (external URL not configured):
```json
{ "error": "No external URL configured for this tool", "code": "NO_EXTERNAL_URL" }
```

**Frontend notes:**
- Since all `/v1/*` routes require a JWT, you cannot use a plain `<a href>` for downloads.  
  Use `fetch` with an `Authorization` header, then create a temporary object URL:

```js
async function downloadTool(toolId, filename) {
  const res = await fetch(`/v1/tools/${toolId}/download`, {
    headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` },
  });

  // External-type tools: browser followed the 302 redirect automatically — nothing more to do.
  if (!res.headers.get('content-disposition')) return;

  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

- `download_count` counts calls, not unique users — refreshing increments it again.

---

### `POST /v1/admin/tools`

Create a new tool entry. Supports two modes depending on the `Content-Type` sent.

**Authentication required. Owner only.**

---

#### Option A — ZIP file upload (`multipart/form-data`)

Send a `multipart/form-data` request with the fields below and a `.zip` file attachment.

| Part | Kind | Required | Description |
|---|---|---|---|
| `name` | field | ✅ | Unique tool name (max 200 chars) |
| `description` | field | ✅ | What the tool does |
| `icon` | field | ❌ | Base64 data URL or external image URL |
| `version` | field | ❌ | Version string, e.g. `"1.2.0"` |
| `tags` | field | ❌ | JSON-encoded array string: `'["csv","formatting"]'` |
| *(any name)* | **file** | ✅ | The `.zip` attachment — max **100 MB** |

**JavaScript example:**
```js
const formData = new FormData();
formData.append('name',        'CSV Formatter');
formData.append('description', 'Formats CSV data into styled tables.');
formData.append('version',     '1.2');
formData.append('tags',        JSON.stringify(['csv', 'formatting']));
formData.append('file',        zipFileBlob, 'csv-formatter-v1.2.zip');

await fetch('/v1/admin/tools', {
  method:  'POST',
  headers: { 'Authorization': `Bearer ${token}` },
  // Do NOT set Content-Type manually — let the browser set it with the multipart boundary
  body: formData,
});
```

---

#### Option B — External link (`application/json`)

Send a normal JSON body with an external download URL instead of a file.

**Request:**
```json
{
  "name":         "Data Visualiser",
  "description":  "Interactive chart builder powered by AI.",
  "icon":         "https://cdn.example.com/icon.png",
  "external_url": "https://releases.example.com/data-viz-v2.zip",
  "version":      "2.0",
  "tags":         ["charts", "visualisation"]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✅ | Unique tool name |
| `description` | string | ✅ | Tool description |
| `icon` | string | ❌ | Image URL or base64 data URL |
| `external_url` | string | ✅ | The external download / redirect URL |
| `version` | string | ❌ | Version string |
| `tags` | string[] | ❌ | Array of tag strings |

---

**Response `201`:** Full tool object.

**Error responses:**

| Status | `code` | Meaning |
|---|---|---|
| `400` | `MISSING_FIELDS` | `name` or `description` not provided |
| `400` | `MISSING_FILE` | Multipart request sent without a `.zip` attachment |
| `400` | `MISSING_EXTERNAL_URL` | JSON request sent without `external_url` |
| `400` | `INVALID_FILE_TYPE` | Attached file is not a `.zip` |
| `409` | `DUPLICATE_NAME` | A tool with that name already exists |
| `413` | `FILE_TOO_LARGE` | File exceeds the 100 MB limit |

---

### `PATCH /v1/admin/tools/:id`

Update tool metadata. Only fields present in the request body are changed.

**Authentication required. Owner only.**

**Request** (any combination of fields):
```json
{
  "name":         "CSV Formatter Pro",
  "description":  "Now supports Excel output in addition to CSV.",
  "icon":         "data:image/png;base64,...",
  "external_url": "https://new-host.example.com/tool.zip",
  "version":      "1.3",
  "tags":         ["csv", "excel", "formatting"]
}
```

| Field | Type | Constraints |
|---|---|---|
| `name` | string | 1–200 chars |
| `description` | string | 1–2000 chars |
| `icon` | string | Base64 data URL or image URL |
| `external_url` | string | New download URL for external-type tools |
| `version` | string | Max 50 chars |
| `tags` | string[] | Replaces the entire tags array |

No additional properties allowed. At least one field required.

**Response `200`:** Updated full tool object.

**Response `404`:**
```json
{ "error": "Tool not found", "id": "..." }
```

---

### `PATCH /v1/admin/tools/:id/toggle`

Toggle a tool's active state. Inactive tools are hidden from regular users — all user-facing endpoints return `404` for them.

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "id": "64f1a2b3c4d5e6f7a8b9c0d1", "is_active": false }
```

---

### `DELETE /v1/admin/tools/:id`

Permanently delete a tool. For ZIP-type tools the file is also removed from the server's disk.

**Authentication required. Owner only.**

**Response `204`:** No content.

---

## 12. Analytics & Logs

### `GET /v1/logs`

Paginated request history.

- **Users** see only their own requests.
- **Owner** sees all requests.

**Authentication required.**

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `50` | Max results (1–500) |
| `skip` | integer | `0` | Offset |
| `model` | string | — | Filter by model name |
| `status` | string | — | `success`, `error`, or `exhausted` |

**Response `200`:**
```json
{
  "total": 1234,
  "limit": 20,
  "skip":  40,
  "logs": [
    {
      "request_id":     "a1b2c3d4-...",
      "model":          "gemini-2.5-flash",
      "api_key_masked": "AIza…a3f9…wxyz",
      "user_email":     "user@example.com",
      "latency_ms":     842,
      "status":         "success",
      "retries":        1,
      "prompt_length":  42,
      "usage_metadata": { "totalTokenCount": 192 },
      "created_at":     "2025-06-10T14:22:11.000Z"
    }
  ]
}
```

---

### `GET /v1/logs/export`

Download request logs as a CSV file.

**Authentication required. Owner only.**

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `days` | integer | `7` | How many days back to export (1–90) |
| `limit` | integer | `5000` | Max rows (1–10000) |

**Response `200`:** `Content-Type: text/csv` with a CSV file download.

Columns: `request_id`, `user_email`, `model`, `status`, `latency_ms`, `retries`, `created_at`

---

### `DELETE /v1/logs`

Purge request logs older than N days.

**Authentication required. Owner only.**

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `older_than_days` | integer | `30` | Delete logs older than this many days (minimum 1) |

**Response `200`:**
```json
{
  "deleted": 12480,
  "cutoff":  "2025-05-11T09:14:00.000Z"
}
```

---

### `GET /v1/errors`

Paginated error log.

**Authentication required. Owner only.**

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `50` | Max results (1–500) |
| `skip` | integer | `0` | Offset |
| `type` | string | — | `429`, `503`, `timeout`, `other` |
| `model` | string | — | Filter by model name |

**Response `200`:**
```json
{
  "total": 88,
  "errors": [
    {
      "type":       "429",
      "model":      "gemini-2.5-flash",
      "key_masked": "AIza…a3f9…wxyz",
      "timestamp":  "2025-06-10T14:20:05.000Z"
    }
  ]
}
```

---

### `GET /v1/usage`

Aggregated statistics.

- **Users** see their own stats only.
- **Owner** sees global stats.

**Authentication required.**

**Response `200`:**
```json
{
  "overall": {
    "total_requests": 50000,
    "total_retries":  320,
    "avg_latency_ms": 415,
    "max_latency_ms": 8200
  },
  "by_model": [
    {
      "model":          "gemini-2.5-flash",
      "requests":       30000,
      "success":        29800,
      "avg_latency_ms": 430
    }
  ],
  "by_status": {
    "success":   49000,
    "error":     700,
    "exhausted": 300
  }
}
```

> `overall` is `null` if no requests have been made yet.

---

### `GET /v1/analytics/time-series`

Request counts over time, bucketed by hour or day.

**Authentication required. Owner only.**

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `interval` | string | `day` | `hour` or `day` |
| `days` | integer | `7` | How many days to look back (1–90) |

**Response `200`:**
```json
{
  "interval": "day",
  "days": 7,
  "buckets": [
    {
      "_id": { "year": 2025, "month": 6, "day": 10 },
      "total":          320,
      "success":        310,
      "errors":         10,
      "avg_latency_ms": 415
    }
  ]
}
```

---

### `GET /v1/analytics/users`

Per-user usage breakdown for the top N most active users.

**Authentication required. Owner only.**

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `20` | Top N users (1–100) |
| `days` | integer | `7` | Time window (1–90 days) |

**Response `200`:**
```json
{
  "days": 7,
  "users": [
    {
      "email":          "alice@example.com",
      "total_requests": 842,
      "success_count":  830,
      "error_count":    12,
      "avg_latency_ms": 390,
      "last_request":   "2025-06-10T14:22:11.000Z"
    }
  ]
}
```

---

### `GET /v1/analytics/errors/summary`

Error breakdown by type and model, with the 10 most recent errors.

**Authentication required. Owner only.**

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `days` | integer | `7` | Time window (1–90 days) |

**Response `200`:**
```json
{
  "days": 7,
  "by_type":  { "429": 45, "503": 12, "timeout": 8, "other": 3 },
  "by_model": { "gemini-2.5-flash": 50, "gemini-2.5-pro": 18 },
  "recent": [
    { "type": "429", "model": "gemini-2.5-flash", "key_masked": "AIza…a3f9…wxyz", "timestamp": "..." }
  ]
}
```

---

## 13. Admin — Key Management

Owner only. Manage the Gemini API key pool. Keys are always **masked** in responses (first 4 + `****` + last 4).

### `GET /v1/keys`

List all keys and their statuses.

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "active": [
    { "key": "AIza…a3f9…wxyz", "status": "active" }
  ],
  "cooldown": [
    { "key": "AIzc****efgh", "status": "cooldown", "cooldownRemainingMs": 45000 },
    { "key": "AIzd****ijkl", "status": "disabled", "cooldownRemainingMs": null }
  ]
}
```

---

### `GET /v1/keys/pool-stats`

Current key pool statistics broken down by state.

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "active":   8,
  "cooldown": 2,
  "disabled": 1,
  "total":    11
}
```

---

### `POST /v1/keys`

Add one or more API keys to the pool.

**Authentication required. Owner only.**

**Request:**
```json
{ "keys": ["AIzaSyABC...", "AIzaSyDEF..."] }
```

**Response `200`:**
```json
{
  "results": [
    { "key": "AIza…a3f9…wxyz", "added": true },
    { "key": "AIza…b7c2…mnop", "added": false, "reason": "already_active" }
  ]
}
```

---

### `PATCH /v1/keys/:key/enable`

Move a cooled-down or disabled key back to active.

**Authentication required. Owner only.**

**`:key`** = URL-encoded raw API key string.

**Response `200`:**
```json
{ "status": "enabled", "key": "AIza…a3f9…wxyz" }
```

---

### `PATCH /v1/keys/:key/disable`

Permanently disable a key.

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "status": "disabled", "key": "AIza…a3f9…wxyz" }
```

---

### `POST /v1/keys/bulk-enable`

Enable multiple keys in one request.

**Authentication required. Owner only.**

**Request:**
```json
{ "keys": ["AIzaSyABC...", "AIzaSyDEF..."] }
```

**Response `200`:**
```json
{
  "results": [
    { "key": "AIza…a3f9…wxyz", "status": "enabled" },
    { "key": "AIza…b7c2…mnop", "status": "enabled" }
  ]
}
```

---

### `POST /v1/keys/bulk-disable`

Disable multiple keys in one request.

**Authentication required. Owner only.**

**Request:**
```json
{ "keys": ["AIzaSyABC...", "AIzaSyDEF..."] }
```

**Response `200`:**
```json
{
  "results": [
    { "key": "AIza…a3f9…wxyz", "status": "disabled" },
    { "key": "AIza…b7c2…mnop", "status": "disabled" }
  ]
}
```

---

### `POST /v1/keys/clear-cooldowns`

Restore all temporarily cooled-down keys to active immediately.  
Permanently disabled keys are **not** affected.

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "restored": 3 }
```

---

### `GET /v1/keys/:key/stats`

Usage statistics for a specific key (queried by masked key string).

**Authentication required. Owner only.**

**`:key`** = masked key, e.g. `AIza…a3f9…wxyz` (URL-encode before use: `encodeURIComponent(key)`)

**Response `200`:**
```json
{
  "key":            "AIza…a3f9…wxyz",
  "total_requests": 1500,
  "success_count":  1480,
  "failure_count":  20,
  "avg_latency_ms": 342,
  "last_used":      "2025-06-10T14:22:11.000Z"
}
```

---

## 14. Admin — Model Config & Health

Owner only. Manage the primary model, fallback chain, image models, and view live health metrics.

### `GET /v1/models/available`

Returns a flat array of all known model names (from health data + config chain). Useful for populating dropdowns.

**Authentication required. Any role.**

**Response `200`:**
```json
{
  "models": ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"]
}
```

---

### `GET /v1/models`

Live health stats for all models that have processed at least one request.

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "models": [
    {
      "model":          "gemini-2.5-flash",
      "success_count":  4820,
      "failure_count":  20,
      "avg_latency_ms": 720,
      "last_updated":   "2025-06-10T14:22:11.000Z"
    }
  ]
}
```

---

### `GET /v1/models/:name/stats`

Stats for a single model.

**Authentication required. Owner only.**

**Response `200`:** Single model stats object.

**Response `404`:**
```json
{ "error": "No data for this model yet" }
```

---

### `PATCH /v1/models/:name`

Reset health counters for a model.

**Authentication required. Owner only.**

**Request:**
```json
{ "action": "reset" }
```

**Response `200`:**
```json
{ "status": "reset", "model": "gemini-2.5-flash" }
```

**Response `400`** (`BAD_ACTION`): Unknown action value.

---

### `GET /v1/models/config`

View the current primary model and ordered fallback chain.

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "primary_model":  "gemini-3-flash-preview",
  "fallback_models": [
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite-preview"
  ]
}
```

> `primary_model` is always `fallback_models[0]` — it is the model chosen when a user omits the `model` field.

---

### `PATCH /v1/models/config`

Replace the fallback chain. Changes take effect immediately.

**Authentication required. Owner only.**

**Request** (either or both fields):
```json
{
  "primary_model":   "gemini-2.5-flash",
  "fallback_models": ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.1-flash-lite-preview"]
}
```

| Field | Type | Description |
|---|---|---|
| `primary_model` | string | Moves this model to position 0. Adds it if absent. |
| `fallback_models` | string[] | Replaces the entire chain (min 1 item). Order matters. |

At least one field required.

**Response `200`:** Updated config (same shape as `GET /v1/models/config`).

---

### `POST /v1/models/config/fallback`

Add a model to the fallback chain without replacing the whole list.

**Authentication required. Owner only.**

**Request:**
```json
{ "model": "gemini-2.5-pro", "position": "start" }
```

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | — | Model name to add (required) |
| `position` | `"start"` \| `"end"` | `"end"` | `"start"` = highest priority, `"end"` = last resort |

**Response `200`:**
```json
{
  "added": true,
  "model": "gemini-2.5-pro",
  "primary_model": "gemini-2.5-pro",
  "fallback_models": ["gemini-2.5-pro", "gemini-3-flash-preview", "gemini-2.5-flash"]
}
```

**Response `409`** (already in list):
```json
{ "error": "Model already in fallback list", "code": "ALREADY_EXISTS", "model": "gemini-2.5-flash" }
```

---

### `DELETE /v1/models/config/fallback/:name`

Remove a model from the fallback chain.

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "removed": true,
  "model": "gemini-2.5-flash-lite",
  "primary_model": "gemini-3-flash-preview",
  "fallback_models": ["gemini-3-flash-preview", "gemini-2.5-flash"]
}
```

**Response `404`:**
```json
{ "error": "Model not in fallback list", "code": "NOT_FOUND", "model": "gemini-2.5-flash-lite" }
```

---

### `GET /v1/models/config/image`

View the configured image generation models.

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "image_models": ["gemini-2.0-flash-preview-image-generation"]
}
```

---

### `PUT /v1/models/config/image`

Replace the entire image models list.

**Authentication required. Owner only.**

**Request:**
```json
{
  "image_models": ["gemini-2.0-flash-preview-image-generation", "imagen-3.0-generate-002"]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `image_models` | string[] | ✅ | At least 1 model. Replaces the entire list. |

**Response `200`:**
```json
{
  "image_models": ["gemini-2.0-flash-preview-image-generation", "imagen-3.0-generate-002"]
}
```

---

## 15. Admin — Queue Management

Owner only.

### `GET /v1/queue/status`

Overview of the BullMQ batch queue.

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "queue": "gemini-batch",
  "counts": {
    "waiting":   5,
    "active":    3,
    "completed": 1240,
    "failed":    2,
    "delayed":   0,
    "paused":    0
  }
}
```

---

### `POST /v1/queue/pause`

Pause the queue — workers stop picking up new jobs. Already-running jobs complete normally.

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "paused": true }
```

---

### `POST /v1/queue/resume`

Resume a paused queue.

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "paused": false }
```

---

### `POST /v1/queue/retry`

Retry all currently failed jobs.

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "retried": 4 }
```

---

### `POST /v1/queue/jobs/:jobId/retry`

Retry a single failed job by its ID.

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "retried": true, "jobId": "aaa-..." }
```

**Response `404`:**
```json
{ "error": "Job not found", "jobId": "aaa-..." }
```

---

### `DELETE /v1/queue/failed`

Remove all failed jobs from the queue.

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "drained": 6 }
```

---

### `DELETE /v1/queue/completed`

Remove all completed jobs from the queue (free memory).

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "drained": 1240 }
```

---

## 16. Admin — System Control

Owner only. Configure live runtime behaviour without restarting the server.

### `GET /v1/admin/system`

View all current system flags and configuration.

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "maintenance_mode":        false,
  "generation_enabled":      true,
  "registration_enabled":    true,
  "hivemind_enabled":        true,
  "default_per_min":         60,
  "alert_failure_threshold": 10,
  "alert_queue_threshold":   100,
  "alert_pool_low_threshold":5,
  "gen_temperature":         null,
  "gen_max_tokens":          null,
  "max_sessions_user":       1,
  "max_sessions_admin":      3,
  "payment_upi_1":           "user@upi",
  "payment_upi_2":           "9876543210@paytm",
  "payment_qr_path":         "",
  "payment_qr_file_id":      "64f1a2b3..."
}
```

> `payment_*` fields reflect the live UPI/QR configuration. The `payment_qr_path` field is the legacy disk path (kept for backwards compatibility); new uploads always populate `payment_qr_file_id` (GridFS ObjectId) instead.

---

### `PATCH /v1/admin/system`

Update one or more runtime flags. Changes take effect immediately for all new requests.

**Authentication required. Owner only.**

**Request** (any combination of fields):
```json
{
  "maintenance_mode":     true,
  "generation_enabled":   false,
  "registration_enabled": false,
  "hivemind_enabled":     false,
  "default_per_min":      120,
  "max_sessions_user":    2,
  "max_sessions_admin":   5
}
```

| Field | Type | Description |
|---|---|---|
| `maintenance_mode` | boolean | `true` = all non-admin `/v1/*` requests get `503 MAINTENANCE_MODE` |
| `generation_enabled` | boolean | `false` = generate/stream/batch return `503 GENERATION_DISABLED` for everyone including admins |
| `registration_enabled` | boolean | `false` = `/auth/login` returns `503 REGISTRATION_DISABLED` |
| `hivemind_enabled` | boolean | `false` = generation requests skip hivemind context retrieval and storage entirely (goes straight to the AI). Defaults to `true`. Independent additional gate on top of the env-based hivemind config. |
| `default_per_min` | integer (≥1) | Global per-minute rate limit for all users without a custom override. Busts all user caches immediately. |
| `alert_failure_threshold` | integer (≥1) | Failures per 5-min window that trigger a high-failure-rate alert email |
| `alert_queue_threshold` | integer (≥1) | Queue waiting jobs count that triggers a backlog alert email |
| `alert_pool_low_threshold` | integer (≥1) | Active key count that triggers a key-pool-low alert email |
| `gen_temperature` | number (0–2) | Override generation temperature for all requests (`null` = use model default) |
| `gen_max_tokens` | integer (≥1) | Override max output tokens for all requests (`null` = use model default) |
| `max_sessions_user` | integer (≥1) | Maximum concurrent sessions allowed per user-role account |
| `max_sessions_admin` | integer (≥1) | Maximum concurrent sessions allowed per admin-role account |

At least one field required. No additional properties allowed.

**Response `200`:**
```json
{ "updated": true, "changes": { "maintenance_mode": true } }
```

---

### `GET /v1/admin/system/plan-limits`

View current daily request limits for each plan (may differ from code defaults if admin has updated them).

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "free":    { "label": "Free",    "daily_requests": 5   },
  "premium": { "label": "Premium", "daily_requests": 500 }
}
```

---

### `PATCH /v1/admin/system/plan-limits`

Change a plan's daily request limit. Takes effect immediately for all users on that plan (busts all Redis caches).

**Authentication required. Owner only.**

**Request:**
```json
{
  "plan":           "free",
  "daily_requests": 10
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `plan` | string | ✅ | `free` or `premium` |
| `daily_requests` | integer (≥1) | ✅ | New daily request limit |

**Response `200`:**
```json
{
  "updated":       true,
  "plan":          "free",
  "daily_requests":10,
  "caches_busted": 84
}
```

> `caches_busted` is the number of per-user rate-limit caches that were cleared so the new limit takes effect instantly.

---

### `GET /v1/admin/whitelist`

List all whitelist rules. When the list is non-empty, only matching emails or domains can sign in.

**Authentication required. Owner only.**

**Response `200`:**
```json
[
  { "type": "domain", "value": "mycompany.com", "note": "All company staff", "created_at": "..." },
  { "type": "email",  "value": "partner@vendor.io", "note": "External contractor", "created_at": "..." }
]
```

> An empty array means open registration — anyone can sign in.

---

### `POST /v1/admin/whitelist`

Add a whitelist rule.

**Authentication required. Owner only.**

**Request:**
```json
{
  "type":  "domain",
  "value": "mycompany.com",
  "note":  "All company staff"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | ✅ | `email` — exact address · `domain` — everyone at this domain |
| `value` | string | ✅ | The email address or domain name (1–200 chars) |
| `note` | string | ❌ | Internal description (up to 500 chars) |

No additional properties allowed.

**Response `201`:**
```json
{ "added": true, "type": "domain", "value": "mycompany.com" }
```

**Response `409`** (rule already exists):
```json
{ "error": "Rule already exists", "reason": "already_exists" }
```

---

### `DELETE /v1/admin/whitelist`

Remove a whitelist rule.

**Authentication required. Owner only.**

**Request:**
```json
{ "type": "domain", "value": "mycompany.com" }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | ✅ | `email` or `domain` |
| `value` | string | ✅ | The exact rule value to remove |

No additional properties allowed.

**Response `200`:**
```json
{ "removed": true, "type": "domain", "value": "mycompany.com" }
```

**Response `404`:**
```json
{ "error": "Rule not found" }
```

---

### `PATCH /v1/admin/system/payment`

Update the UPI payment IDs displayed in the in-app payment modal. Either or both fields may be provided.

**Authentication required. Owner only.**

**Request:**
```json
{
  "upi_1": "user@upi",
  "upi_2": "9876543210@paytm"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `upi_1` | string | ❌ | Primary UPI ID (max 100 chars). Send empty string to clear. |
| `upi_2` | string | ❌ | Secondary UPI ID (max 100 chars). Send empty string to clear. |

No additional properties allowed.

**Response `200`:**
```json
{ "updated": true, "upi_1": "user@upi", "upi_2": "9876543210@paytm" }
```

> Audited as `payment_config_update`.

---

### `POST /v1/admin/system/payment-qr`

Upload a payment QR code image. Replaces any existing QR (old GridFS file and any legacy disk file are deleted).

**Authentication required. Owner only.**

**Request:** `multipart/form-data` with a single file part.

| Part | Kind | Required | Description |
|---|---|---|---|
| *(any name)* | **file** | ✅ | Image file. Allowed extensions: `.jpg`, `.jpeg`, `.png`, `.webp` |

The file is streamed into MongoDB GridFS under the `tools` bucket with metadata `{ type: "payment_qr", originalName: <filename> }`.

**Response `200`:**
```json
{
  "success":  true,
  "filename": "qr-code.png",
  "fileId":   "64f1a2b3c4d5e6f7a8b9c0d1"
}
```

**Error responses:**

| Status | `code` | Meaning |
|---|---|---|
| `400` | `NOT_MULTIPART` | Request body was not `multipart/form-data` |
| `400` | `NO_FILE` | Multipart request sent without a file part |
| `400` | `INVALID_TYPE` | File extension is not jpg/jpeg/png/webp |

> Audited as `payment_qr_upload`.

---

### `DELETE /v1/admin/system/payment-qr`

Remove the configured payment QR code (deletes the GridFS file and clears any legacy disk reference).

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "success": true }
```

> Always returns success even if no QR was configured. Audited as `payment_qr_delete`.

---

### `GET /v1/admin/system/emails`

View which categories of system emails are currently enabled. The OTP email is always on and cannot be disabled.

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "security":     true,
  "status":       true,
  "tickets":      true,
  "quota":        false,
  "admin_health": true,
  "otp":          true
}
```

| Field | Triggers |
|---|---|
| `security` | New-device login notification, account-blocked notification |
| `status` | Account status change (block / unblock / role / plan change) |
| `tickets` | Admin response & ticket-resolved emails to ticket creator |
| `quota` | Daily-quota exceeded notice to user |
| `admin_health` | Owner alert emails (high failure rate, queue backlog, key pool low, daily summary, test email) |
| `otp` | Sign-in OTP — always `true`, not toggleable |

---

### `PATCH /v1/admin/system/emails`

Enable or disable categories of system emails. At least one field is required; only fields present are changed.

**Authentication required. Owner only.**

**Request:**
```json
{
  "security":     true,
  "status":       true,
  "tickets":      true,
  "quota":        false,
  "admin_health": true
}
```

| Field | Type | Description |
|---|---|---|
| `security` | boolean | Toggle security/login emails |
| `status` | boolean | Toggle account status change emails |
| `tickets` | boolean | Toggle ticket admin-response emails |
| `quota` | boolean | Toggle daily-quota exceeded emails |
| `admin_health` | boolean | Toggle owner alert / daily summary emails |

The `otp` field cannot be modified. No additional properties allowed.

**Response `200`:**
```json
{
  "updated":      true,
  "security":     true,
  "status":       true,
  "tickets":      true,
  "quota":        false,
  "admin_health": true,
  "otp":          true
}
```

> Audited as `email_config_update`.

**Response `200`:**
```json
{ "removed": true, "type": "domain", "value": "mycompany.com" }
```

**Response `404`:**
```json
{ "error": "Rule not found" }
```

---

### `PATCH /v1/admin/system/payment`

Update the UPI IDs for manual payments.

**Authentication required. Owner only.**

**Request:**
```json
{ "upi_1": "user@upi", "upi_2": "9876543210@paytm" }
```

| Field | Type | Constraints |
|---|---|---|
| `upi_1` | string | Max 100 chars |
| `upi_2` | string | Max 100 chars |

No additional properties allowed.

**Response `200`:**
```json
{ "updated": true, "upi_1": "user@upi", "upi_2": "9876543210@paytm" }
```

---

### `POST /v1/admin/system/payment-qr`

Upload a QR code image for manual payments.

**Authentication required. Owner only.**

**Request:** `multipart/form-data` with a single file field named **`file`** (JPG, JPEG, PNG, or WebP). Stored in GridFS.

**Response `200`:**
```json
{ "success": true, "filename": "payment-qr.png", "fileId": "64f1..." }
```

---

### `DELETE /v1/admin/system/payment-qr`

Delete the uploaded payment QR code.

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "success": true }
```

---

### `GET /v1/admin/system/emails`

View status of email notification toggles.

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "security":     true,
  "status":       true,
  "tickets":      true,
  "quota":        true,
  "admin_health": true,
  "otp":          true
}
```

> `otp` is always `true` and cannot be toggled — OTP emails are always sent.

---

### `PATCH /v1/admin/system/emails`

Toggle specific email notifications.

**Authentication required. Owner only.**

**Request:**
```json
{
  "security":     true,
  "status":       false,
  "tickets":      true,
  "quota":        true,
  "admin_health": false
}
```

| Field | Type | Description |
|---|---|---|
| `security` | boolean | Login/session security emails |
| `status` | boolean | Account status change emails |
| `tickets` | boolean | Ticket response/closure emails |
| `quota` | boolean | Quota warning emails |
| `admin_health` | boolean | Admin health alert emails |

No additional properties allowed.

**Response `200`:**
```json
{ "updated": true, "security": true, "status": false, "tickets": true, "quota": true, "admin_health": false }
```

---

## 17. Admin — Alerts & Notifications

Owner only. Manage alert throttles and notification configuration.

### `GET /v1/admin/alerts/throttles`

View all active alert throttle keys. Each key prevents the same alert type from firing again until its TTL expires.

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "throttles": [
    { "key": "alert:no_keys",        "ttl_seconds": 480 },
    { "key": "alert:queue_backlog",  "ttl_seconds": 721 },
    { "key": "alert:key_pool_low",   "ttl_seconds": 1200 }
  ]
}
```

---

### `DELETE /v1/admin/alerts/throttles`

Clear **all** alert throttle keys — re-arms every alert type so they can fire again immediately.

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "cleared": 3 }
```

---

### `DELETE /v1/admin/alerts/throttles/:key`

Clear a single throttle key. `:key` is the part after `alert:`, e.g. `no_keys`.

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "cleared": 1, "key": "alert:no_keys" }
```

**Response `404`:** Key not found.

---

### `GET /v1/admin/alerts/thresholds`

View the current alert threshold values.

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "alert_failure_threshold":  10,
  "alert_queue_threshold":    100,
  "alert_pool_low_threshold": 5
}
```

---

### `PATCH /v1/admin/alerts/thresholds`

Update alert thresholds. Changes take effect on the next check interval.

**Authentication required. Owner only.**

**Request:**
```json
{
  "alert_failure_threshold":  20,
  "alert_queue_threshold":    50,
  "alert_pool_low_threshold": 3
}
```

At least one field required. No additional properties allowed.

**Response `200`:**
```json
{ "updated": true, "thresholds": { "alert_failure_threshold": 20 } }
```

---

### `POST /v1/admin/alerts/test`

Send a test email to the owner address to verify email delivery is working.

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "sent": true, "to": "owner@example.com" }
```

**Response `422`:**
```json
{ "error": "OWNER_EMAIL not configured — cannot send test email" }
```

**Response `502`:** Email delivery failed.

---

### `POST /v1/admin/alerts/daily-summary`

Trigger the daily summary email on-demand (same email that normally fires at 08:00 UTC).

**Authentication required. Owner only.**

**Response `200`:**
```json
{ "triggered": true }
```

**Response `422`:** `OWNER_EMAIL` not configured.

> The email is sent asynchronously — the response returns immediately.

---

## 18. Admin — Health Dashboard

Owner only.

### `GET /v1/admin/health`

Full system health snapshot — MongoDB, Redis, key pool, queue, latency metrics, failure rate, and system config in one call.

**Authentication required. Owner only.**

**Response `200`:**
```json
{
  "timestamp": "2025-06-10T14:22:11.000Z",
  "pulse": "healthy",
  "load_pct": 25,
  "mongo": {
    "status":       "up",
    "user_count":   142,
    "ticket_count": 48
  },
  "redis": {
    "status":      "up",
    "latency_ms":  2,
    "used_memory": "12.50M",
    "peak_memory": "14.20M"
  },
  "key_pool": {
    "active":   8,
    "cooldown": 1,
    "disabled": 0,
    "total":    9
  },
  "queue": {
    "waiting":   0,
    "active":    2,
    "completed": 4820,
    "failed":    1,
    "delayed":   0,
    "paused":    0
  },
  "latency": {
    "queue_wait":  { "avg": 18, "p95": 45, "count": 4823 },
    "generation":  { "avg": 780, "p95": 2100, "count": 4820 }
  },
  "failure_rate": {
    "last_5_min":      3,
    "alert_threshold": 10
  },
  "system_config": {
    "maintenance_mode":     false,
    "generation_enabled":   true,
    "registration_enabled": true,
    "default_per_min":      60,
    "worker_concurrency":   5
  }
}
```

**Field details:**

| Field | Description |
|---|---|
| `pulse` | System health: `"healthy"`, `"degraded"` (failures > threshold or worker load > 90%), or `"critical"` (failures > 2× threshold) |
| `load_pct` | Worker load percentage (active jobs / concurrency × 100, capped at 100) |
| `latency.queue_wait` | Queue wait time percentiles from Prometheus metrics |
| `latency.generation` | Generation latency percentiles from Prometheus metrics |

**Frontend notes:**
- Any sub-object may have `{ "status": "error", "error": "..." }` if that component is unreachable
- `failure_rate.last_5_min` = number of 429/503/timeout failures in the last 5 minutes — alert fires when this exceeds `alert_threshold`
- Use this endpoint to build an admin dashboard status page

---

## 19. Admin — Audit Log

Owner only. Every sensitive admin action is recorded.

### `GET /v1/admin/audit-log`

Query the audit log with optional filters and pagination.

**Authentication required. Owner only.**

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `actor_email` | string | — | Filter by the admin who performed the action |
| `action` | string | — | Filter by action type (e.g. `block_user`, `change_role`) |
| `target_email` | string | — | Filter by the user the action was performed on |
| `from` | ISO string | — | Actions on or after this timestamp |
| `to` | ISO string | — | Actions on or before this timestamp |
| `limit` | integer | `100` | Max results (1–500) |
| `skip` | integer | `0` | Offset |

**Response `200`:**
```json
{
  "total": 284,
  "logs": [
    {
      "actor_email":  "admin@example.com",
      "action":       "block_user",
      "target_email": "alice@example.com",
      "meta":         {},
      "created_at":   "2025-06-10T14:22:11.000Z"
    },
    {
      "actor_email":  "owner@example.com",
      "action":       "plan_limit_update",
      "target_email": null,
      "meta":         { "plan": "free", "daily_requests": 10, "caches_busted": 84 },
      "created_at":   "2025-06-10T13:00:00.000Z"
    }
  ]
}
```

**Logged action types:**

| Action | Triggered by |
|---|---|
| `block_user` | `PATCH /v1/users/:email/block` |
| `unblock_user` | `PATCH /v1/users/:email/unblock` |
| `change_role` | `PATCH /v1/users/:email/role` |
| `bulk_block` | `POST /v1/users/bulk` with `action: block` |
| `bulk_unblock` | `POST /v1/users/bulk` with `action: unblock` |
| `bulk_set_plan` | `POST /v1/users/bulk` with `action: set_plan` |
| `impersonate` | `POST /v1/users/:email/impersonate` |
| `update_ticket` | `PATCH /v1/tickets/:id` |
| `bulk_closed_tickets` | `POST /v1/tickets/bulk-close` |
| `bulk_resolved_tickets` | `POST /v1/tickets/bulk-close` with `status: resolved` |
| `key_enable` | `PATCH /v1/keys/:key/enable` |
| `key_disable` | `PATCH /v1/keys/:key/disable` |
| `bulk_key_enable` | `POST /v1/keys/bulk-enable` |
| `bulk_key_disable` | `POST /v1/keys/bulk-disable` |
| `clear_cooldowns` | `POST /v1/keys/clear-cooldowns` |
| `system_config_update` | `PATCH /v1/admin/system` |
| `plan_limit_update` | `PATCH /v1/admin/system/plan-limits` |
| `whitelist_add` | `POST /v1/admin/whitelist` |
| `whitelist_remove` | `DELETE /v1/admin/whitelist` |
| `payment_config_update` | `PATCH /v1/admin/system/payment` |
| `payment_qr_upload` | `POST /v1/admin/system/payment-qr` |
| `payment_qr_delete` | `DELETE /v1/admin/system/payment-qr` |
| `email_config_update` | `PATCH /v1/admin/system/emails` |
| `alert_throttles_cleared` | `DELETE /v1/admin/alerts/throttles` |
| `alert_thresholds_update` | `PATCH /v1/admin/alerts/thresholds` |
| `test_email_sent` | `POST /v1/admin/alerts/test` |
| `daily_summary_triggered` | `POST /v1/admin/alerts/daily-summary` |
| `create_tool` | `POST /v1/admin/tools` |
| `update_tool` | `PATCH /v1/admin/tools/:id` |
| `toggle_tool` | `PATCH /v1/admin/tools/:id/toggle` |
| `delete_tool` | `DELETE /v1/admin/tools/:id` |

---

## 20. Payment & System Info Routes

These endpoints expose UPI payment configuration to authenticated clients (the in-app payment modal). They are mounted inside the protected `/v1/*` scope, so a valid JWT is required.

### `GET /v1/system/payment-details`

Get the configured UPI payment details and QR code availability.

**Authentication required. Any role.**

**Response `200`:**
```json
{
  "upi_1":  "user@upi",
  "upi_2":  "9876543210@paytm",
  "has_qr": true,
  "qr_id":  "64f1a2b3..."
}
```

> `has_qr` is `false` and `qr_id` is `null` if no QR code has been uploaded.
> The raw filesystem `payment_qr_path` is intentionally never exposed — clients must use either `qr_id` (GridFS ObjectId) or fetch `/v1/system/payment-qr` directly.

---

### `GET /v1/system/payment-qr`

Download the payment QR code image. Streams the file from GridFS (preferred) with a legacy fallback to the local `uploads/` directory.

**Authentication required. Any role.**

**Response `200`:** Binary image stream with appropriate `Content-Type` (`image/png`, `image/jpeg`, or `image/webp`).

**Response `403`** (`FORBIDDEN`): Legacy disk path resolved outside of `uploads/`.

**Response `404`:**
```json
{ "error": "QR code not found", "code": "QR_NOT_FOUND" }
```

> To configure these values, owners use the admin endpoints in [Section 16 — Admin System Control](#16-admin--system-control): `PATCH /v1/admin/system/payment` (UPI IDs), `POST /v1/admin/system/payment-qr` (upload QR), `DELETE /v1/admin/system/payment-qr` (remove QR).

---

## 21. Infrastructure

### `GET /health`

Basic health check. Public — no authentication required.

**Response `200`:**
```json
{ "status": "ok" }
```

---

### `GET /health/deep`

Deep health check including Redis connectivity. Public — no authentication required.

**Response `200`:**
```json
{ "status": "ok", "redis": "ok" }
```

**Response `503`** (Redis unreachable):
```json
{ "status": "degraded", "redis": "error: connect ECONNREFUSED" }
```

---

### `GET /v1/metrics`

Prometheus-format metrics.

**Authentication required. Owner only.**

**Response `200`** (`Content-Type: text/plain; version=0.0.4`):
```
# HELP gemini_requests_total Total number of generation requests
# TYPE gemini_requests_total counter
gemini_requests_total{model="gemini-2.5-flash",status="success"} 4820
...
```

| Metric | Type | Description |
|---|---|---|
| `gemini_requests_total` | Counter | Requests by `model` + `status` |
| `gemini_request_duration_ms` | Histogram | End-to-end latency by `model` |
| `gemini_retries_total` | Counter | Retry count by `model` |
| `gemini_key_cooldowns_total` | Counter | Total 429 key cooldowns |
| `gemini_active_keys` | Gauge | Keys currently available |
| `gemini_cooldown_keys` | Gauge | Keys on cooldown |
| `gemini_model_503_total` | Counter | 503 errors by `model` |
| `gemini_model_timeouts_total` | Counter | Timeouts by `model` |
| `gemini_queue_size` | Gauge | Jobs by queue `state` |
| `gemini_worker_active_jobs` | Gauge | Active worker jobs |

---

### `POST /v1/debug/test-key`

Test a specific API key against Gemini.

**Authentication required. Owner only.**

**Request:**
```json
{ "key": "AIzaSyABC...", "model": "gemini-2.5-flash" }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✅ | Raw API key to test |
| `model` | string | ❌ | Model to test against. Defaults to the configured default model. |

**All outcomes return HTTP `200`** — check the `ok` boolean:
```json
{ "ok": true,  "status": 200, "latency_ms": 312, "model": "gemini-2.5-flash" }
{ "ok": false, "status": 429, "error": "...",     "latency_ms": 80 }
```

---

### `POST /v1/debug/test-model`

Test a model using the next available key from the pool.

**Authentication required. Owner only.**

**Request:**
```json
{ "model": "gemini-2.5-flash" }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | Model to test |

**Response `200`:**
```json
{ "ok": true, "status": 200, "latency_ms": 290, "model": "gemini-2.5-flash" }
```

**Response `503`:**
```json
{ "ok": false, "error": "No keys available" }
```

---

## 22. Error Reference

### Standard Error Shape

```json
{
  "error":      "Human-readable message",
  "code":       "MACHINE_READABLE_CODE",
  "request_id": "uuid (only on /v1/generate errors)"
}
```

### HTTP Status Codes

| Status | Meaning |
|---|---|
| `200` | Success |
| `201` | Resource created (tickets, tools, whitelist rules) |
| `204` | Success, no content (delete operations) |
| `400` | Bad request — check your request body/params |
| `401` | Unauthorized — missing/expired/invalid token |
| `403` | Forbidden — account blocked, wrong role, or impersonation write attempt |
| `404` | Resource not found |
| `409` | Conflict — resource already exists |
| `413` | Payload too large — uploaded file exceeds the size limit |
| `422` | Unprocessable — missing required server config (e.g. OWNER_EMAIL) |
| `429` | Rate limit exceeded |
| `502` | Upstream network error (Gemini unreachable) |
| `503` | Service unavailable — maintenance mode, generation disabled, no keys, pool exhausted, or DB/Redis down |
| `504` | Gateway timeout — Gemini took too long |

### Auth Error Codes

| `error` | What happened | What to do |
|---|---|---|
| `Missing or malformed Authorization header` | No Bearer token | Redirect to login |
| `token_expired` | JWT past expiry | Redirect to login |
| `invalid_token` | JWT malformed | Redirect to login |
| `session_not_found` | Session deleted | Redirect to login |
| `session_superseded` | Logged in on another device | Notify + redirect to login |
| `ACCOUNT_BLOCKED` | Admin blocked this account | Show block notice |
| `IMPERSONATION_READ_ONLY` | Write attempted with impersonation token | Show read-only notice |

### System Error Codes

| `code` | What happened | What to do |
|---|---|---|
| `MAINTENANCE_MODE` | System under maintenance | Show maintenance page, retry later |
| `GENERATION_DISABLED` | AI generation paused by admin | Show notice, retry later |
| `REGISTRATION_DISABLED` | New sign-ins paused by admin | Show notice on login page |
| `NOT_WHITELISTED` | Email not in the allowed list | Show access denied message |
| `DB_UNAVAILABLE` | Database connection error | Retry later |

### Tool Error Codes

| `code` | What happened |
|---|---|
| `MISSING_FIELDS` | `name` or `description` not provided in the create request |
| `MISSING_FILE` | Multipart upload sent without a `.zip` file attachment |
| `MISSING_EXTERNAL_URL` | JSON create request sent without `external_url` |
| `INVALID_FILE_TYPE` | Attached file is not a `.zip` |
| `DUPLICATE_NAME` | A tool with that name already exists |
| `FILE_TOO_LARGE` | Uploaded file exceeds the 100 MB limit |
| `FILE_NOT_FOUND` | ZIP-type tool's file has been deleted from the server disk |
| `NO_EXTERNAL_URL` | External-type tool has no URL configured |
| `QR_NOT_FOUND` | Payment QR code not uploaded |

### Generation Error Codes

| `code` | What happened |
|---|---|
| `RATE_LIMIT_EXCEEDED` | Per-minute limit hit. Check `reset_in_seconds`. |
| `DAILY_LIMIT_EXCEEDED` | Daily plan quota hit. Check `limit` and `reset_in_seconds`. |
| `NO_KEYS` | All API keys are in cooldown. Retry in ~60 seconds. |
| `POOL_EXHAUSTED` | Key pool completely exhausted — circuit breaker tripped. |
| `RETRIES_EXHAUSTED` | Tried 8 times across multiple keys/models, all failed. |
| `UPSTREAM_ERROR` | Network-level failure reaching Google. |
| `TIMEOUT` | Gemini took longer than 25 seconds to respond. |
| `STREAM_ERROR` | Stream was interrupted mid-generation. |

---

## 23. Full Flow Examples

### Complete Login Flow

```js
// 1. Request OTP
await fetch('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com' }),
});

// 2. Verify OTP
const res = await fetch('/auth/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com', otp: '481920' }),
});
const { token } = await res.json();
localStorage.setItem('auth_token', token);

// 3. Use API
const gen = await fetch('/v1/generate', {
  method: 'POST',
  headers: {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({ prompt: 'Hello world' }),
});
console.log((await gen.json()).text);

// 4. Logout
await fetch('/auth/logout', {
  method:  'POST',
  headers: { 'Authorization': `Bearer ${token}` },
});
localStorage.removeItem('auth_token');
```

---

### Building a Chat App

```js
const chatHistory = [];

async function sendMessage(userText) {
  const res = await fetch('/v1/generate', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${localStorage.getItem('auth_token')}`,
    },
    body: JSON.stringify({
      systemInstruction: 'You are a concise coding assistant.',
      history: chatHistory,
      prompt:  userText,
    }),
  });

  const data = await res.json();

  chatHistory.push({ role: 'user',  text: userText });
  chatHistory.push({ role: 'model', text: data.text });

  return data.text;
}
```

---

### Using Embeddings

```js
// Single text embedding
const res = await fetch('/v1/embeddings', {
  method: 'POST',
  headers: {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({ text: 'What is machine learning?' }),
});
const { embedding } = await res.json();
console.log(embedding.values); // [0.0123, -0.0456, ...]

// Batch embeddings
const batchRes = await fetch('/v1/embeddings', {
  method: 'POST',
  headers: {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({
    text: ['First text', 'Second text', 'Third text'],
    model: 'gemini-embedding-2-preview',
  }),
});
const data = await batchRes.json();
```

---

### Admin: Enabling Maintenance Mode

```js
// 1. Enable maintenance mode
await api.patch('/v1/admin/system', { maintenance_mode: true });

// 2. Do your maintenance work...

// 3. Re-enable the service
await api.patch('/v1/admin/system', {
  maintenance_mode:   false,
  generation_enabled: true,
});

// 4. Check health after restart
const health = await api.get('/v1/admin/health');
console.log(health.data.pulse);           // "healthy"
console.log(health.data.mongo.status);    // "up"
console.log(health.data.key_pool.active); // 8
```

---

### Admin: Updating Plan Limits

```js
// 1. Check current limits
const limits = await api.get('/v1/admin/system/plan-limits');
console.log(limits.data.free.daily_requests); // 5

// 2. Raise free plan limit
await api.patch('/v1/admin/system/plan-limits', {
  plan: 'free',
  daily_requests: 20,
});
// All free-plan users now get 20 requests/day immediately
// (Redis caches were busted automatically)
```

---

## 24. Tester Use Cases & Verification

This section provides specific scenarios for the QA team to verify system integrity and edge-case handling.

### 1. User Authentication & Session Security
- **Use Case:** Verify single-device enforcement.
- **Scenario:** Log in on Device A. Then log in on Device B with the same email.
- **Expected:** Device A should receive an email about a new login, and its next API request should return `401 session_superseded`.

### 2. AI Generation Fallback
- **Use Case:** Verify model retry logic.
- **Scenario:** Use a blocked/disabled API key or trigger a 503 from a specific model.
- **Expected:** The server should automatically retry with a different key or fallback model. Response should contain `retries > 0`.

### 3. Rate Limiting & Quotas
- **Use Case:** Verify daily quota exhaustion.
- **Scenario:** Perform requests until the `free` plan limit (default 5) is reached.
- **Expected:** The 6th request should return `429 DAILY_LIMIT_EXCEEDED` with a `reset_in_seconds` value.

### 4. Admin System Control
- **Use Case:** Verify Maintenance Mode.
- **Scenario:** Enable `maintenance_mode` via `PATCH /v1/admin/system`.
- **Expected:** Non-admin users should get `503 MAINTENANCE_MODE`. Admins and owner should be able to continue using the API.

### 5. Support Ticket Attachments
- **Use Case:** Verify screenshot upload and retrieval.
- **Scenario:** Create a ticket with a PNG screenshot. Download it via `/v1/tickets/:id/screenshot`.
- **Expected:** The download should return the identical binary file with the correct `Content-Type`.

### 6. Tools Marketplace
- **Use Case:** Verify ZIP download tracking.
- **Scenario:** Note the current `download_count` for a tool. Download it.
- **Expected:** The `download_count` should increment by 1.

### 7. Embeddings
- **Use Case:** Verify text embedding generation.
- **Scenario:** Send a single text and a batch of texts to `POST /v1/embeddings`.
- **Expected:** Single text returns `embedding.values` array. Batch returns `embeddings` array.

### 8. Circuit Breaker
- **Use Case:** Verify pool exhaustion fast-fail.
- **Scenario:** Disable all API keys, then send a generation request.
- **Expected:** Should return `503 NO_KEYS` or `503 POOL_EXHAUSTED` without waiting for retries.

### 9. Image Model Config
- **Use Case:** Verify image model management.
- **Scenario:** Use `GET /v1/models/config/image` to view, then `PUT /v1/models/config/image` to update.
- **Expected:** Image model list should be persisted and retrievable.

### 10. Payment System
- **Use Case:** Verify public payment details.
- **Scenario:** Call `GET /v1/system/payment-details` without authentication.
- **Expected:** Should return UPI IDs and QR availability without requiring a JWT.

---

## Endpoint Summary

| Section | Endpoints | Auth Level |
|---|---|---|
| Auth | 4 | Public (login/verify) + JWT (logout/me) |
| Generate | 1 | User + Rate Limited |
| Embeddings | 1 | User + Rate Limited |
| Stream | 1 | User + Rate Limited |
| Batch | 1 | User + Rate Limited |
| Users | 12 | Mixed (User/Admin/Owner) |
| Tickets | 8 | Mixed (User/Admin/Owner) |
| Tools (user) | 3 | User |
| Analytics & Logs | 9 | Mixed (User/Owner) |
| Keys | 9 | Owner |
| Models | 10 | Mixed (User/Owner) |
| Queue | 8 | Owner |
| Metrics | 1 | Owner |
| Debug | 2 | Owner |
| Admin System | 12 | Owner |
| Admin Alerts | 7 | Owner |
| Admin Health | 1 | Owner |
| Admin Audit | 1 | Owner |
| Admin Tools | 4 | Owner |
| Payment / System Info | 2 | JWT (any role) |
| Health | 2 | Public |
| **Total** | **99** | |
