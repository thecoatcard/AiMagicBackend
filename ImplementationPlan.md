# Admin Panel — Feature Implementation Plan

> **How to read this document**
> Each feature shows its **Priority** (High / Medium / Low), **Backend Status** (exists / needs new endpoint / needs config change), and a clear description of what needs to be built.

---

## 1. Global System Controls

These are the "master switches" an admin should be able to flip without touching code or restarting the server.

### 1.1 Maintenance Mode
**Priority:** High | **Backend:** Needs new endpoint

Toggle a Redis flag `system:maintenance = 1`. All `/v1/*` routes return `503 Service Unavailable` for regular users while the flag is set. Admins and owner are unaffected.

- `PATCH /v1/admin/system/maintenance` — `{ enabled: true | false }`
- `GET /v1/admin/system/maintenance` — returns current state
- Middleware reads the flag from Redis on every request (cached 5 s to avoid overhead).

---

### 1.2 Service-Wide Generation Toggle
**Priority:** High | **Backend:** Needs new endpoint

Disable only the Gemini generation routes (`/v1/generate`, `/v1/generate/stream`, `/v1/generate/batch`) without putting the whole system in maintenance mode. Useful when all keys are exhausted and you want to stop requests queuing up.

- `PATCH /v1/admin/system/generation` — `{ enabled: true | false }`
- `GET /v1/admin/system/generation`
- Stored in Redis: `system:generation_enabled` (default `1`).

---

### 1.3 User Registration Toggle
**Priority:** High | **Backend:** Needs new endpoint

Block new accounts from being created. Existing users can still log in; `POST /auth/login` for an unknown email returns `403 Registration disabled`.

- `PATCH /v1/admin/system/registration` — `{ enabled: true | false }`
- Stored in Redis: `system:registration_enabled` (default `1`).

---

### 1.4 Email Whitelist (Allowlist Registration)
**Priority:** High | **Backend:** Needs new endpoint + new MongoDB collection

Only allow specific email addresses (or entire domains) to create accounts. Checked at OTP request time.

- `GET /v1/admin/whitelist` — list all rules
- `POST /v1/admin/whitelist` — `{ type: 'email' | 'domain', value: 'user@example.com' | 'example.com' }`
- `DELETE /v1/admin/whitelist/:id` — remove a rule
- When whitelist is non-empty, any email not matching a rule gets `403 Not on whitelist`.
- When whitelist is empty, all emails are allowed (current behaviour).
- Stored in MongoDB collection `whitelist` with indexes on `type` + `value`.

---

### 1.5 Plan Limits Configuration via API
**Priority:** High | **Backend:** Needs new endpoint

Currently `src/config/plans.js` is a hard-coded file — limits require a code edit and restart. Move plan limits to Redis so they can be changed live.

- `GET /v1/admin/plans` — returns all plan configs `{ free: { daily_requests: 5 }, premium: { daily_requests: 500 } }`
- `PATCH /v1/admin/plans/:plan` — `{ daily_requests: 20 }` — updates Redis and busts all affected user limit caches
- On startup, seed Redis from `plans.js` if not already set (so existing deploys keep working).

---

### 1.6 Default Rate Limit Settings
**Priority:** Medium | **Backend:** Needs new endpoint

Currently `DEFAULT_MAX_PER_MIN = 60` is hardcoded. Expose it as a live-configurable value.

- `GET /v1/admin/system/rate-limits` — `{ default_per_min: 60 }`
- `PATCH /v1/admin/system/rate-limits` — `{ default_per_min: 30 }`
- Stored in Redis: `system:default_per_min`. Rate-limiter middleware reads this as fallback when no user-specific limit is set.

---

### 1.7 Gemini Generation Parameters
**Priority:** Medium | **Backend:** Needs new endpoint

`temperature` and `maxOutputTokens` are hardcoded in `src/services/gemini.js`. Expose them.

- `GET /v1/admin/system/generation-params`
- `PATCH /v1/admin/system/generation-params` — `{ temperature: 0.7, maxOutputTokens: 4096 }`
- Stored in Redis hash `system:gen_params`. Read by gemini service on every call.

---

## 2. User Management

### 2.1 User Search & Filtering
**Priority:** High | **Backend:** Needs query param additions to existing endpoint

`GET /v1/users` currently only supports `limit`/`skip`. Add:

- `?role=admin` — filter by role
- `?plan=free` — filter by plan
- `?status=blocked` — filter by status
- `?email=foo` — partial email search (case-insensitive)
- `?sort=created_at:desc` — sorting

No schema change needed; MongoDB query update only.

---

### 2.2 User Statistics Summary
**Priority:** High | **Backend:** Needs new endpoint

Single endpoint that returns aggregate counts useful for an admin dashboard header.

- `GET /v1/admin/stats/users` — returns:
  ```json
  {
    "total": 120,
    "by_role":   { "user": 118, "admin": 1, "owner": 1 },
    "by_plan":   { "free": 100, "premium": 20 },
    "by_status": { "active": 115, "blocked": 5 },
    "new_today": 3
  }
  ```

---

### 2.3 Bulk User Operations
**Priority:** Medium | **Backend:** Needs new endpoint

Perform the same action on multiple users in one API call.

- `POST /v1/admin/users/bulk` — `{ action: 'block' | 'unblock' | 'set_plan', emails: [...], plan?: 'free' }` 
- Returns per-email success/failure results.
- Reuses existing `setUserStatus`, `setUserPlan` DB functions under the hood.

---

### 2.4 Impersonate / View-As-User
**Priority:** Low | **Backend:** Needs new endpoint

Admin gets a temporary read-only token scoped to a specific user's email to debug quota/usage issues without needing their credentials.

- `POST /v1/admin/users/:email/impersonate` — returns a short-lived JWT (15 min) with the user's email and role but with `impersonated: true` in the payload.
- The impersonation token is logged in MongoDB audit log.
- Impersonated sessions cannot call mutating routes.

---

## 3. Key Pool Management

### 3.1 Bulk Key Enable / Disable
**Priority:** High | **Backend:** Needs new endpoint

Current API operates on one key at a time. Add bulk operations.

- `POST /v1/keys/bulk-enable` — `{ keys: ['key1', 'key2'] }`
- `POST /v1/keys/bulk-disable` — `{ keys: ['key1', 'key2'] }`

---

### 3.2 Clear All Cooldowns
**Priority:** High | **Backend:** Needs new endpoint

Move all non-permanently-disabled keys from the cooldown ZSET back to the active list in one shot.

- `POST /v1/keys/clear-cooldowns` — atomically restores all keys whose score is not `DISABLED_SCORE`.
- Returns `{ restored: 5 }`.

---

### 3.3 Key Pool Health Snapshot
**Priority:** High | **Backend:** Needs new endpoint

One endpoint for a full picture of the key pool state, useful as a dashboard widget.

- `GET /v1/admin/stats/keys` — returns:
  ```json
  {
    "active": 8,
    "cooldown": 2,
    "disabled": 1,
    "total": 11,
    "pool_health_pct": 73
  }
  ```

---

### 3.4 Key Rotation — Auto-Delete Disabled Keys Older Than N Days
**Priority:** Low | **Backend:** Needs new endpoint + scheduled job

- `PATCH /v1/admin/system/key-rotation` — `{ auto_purge_disabled_after_days: 30 }`
- Background cron checks daily; removes permanently-disabled keys from the ZSET if they've been there longer than the configured duration.

---

## 4. Ticket Management

### 4.1 Ticket Filtering & Search
**Priority:** High | **Backend:** Needs query param additions to existing endpoint

`GET /v1/tickets` (admin view) currently supports `status`, `priority`, `email`. Add:

- `?search=keyword` — full-text search on `subject` and `description` (MongoDB text index)
- `?sort=created_at:desc` — sorting
- `?from=2024-01-01&to=2024-01-31` — date range

---

### 4.2 Ticket Statistics
**Priority:** High | **Backend:** Needs new endpoint

- `GET /v1/admin/stats/tickets` — returns:
  ```json
  {
    "total": 45,
    "by_status":   { "open": 12, "in_progress": 5, "resolved": 20, "closed": 8 },
    "by_priority": { "low": 10, "medium": 25, "high": 10 },
    "avg_resolution_hours": 18.4,
    "open_high_priority": 3
  }
  ```

---

### 4.3 Admin Can Update Ticket Priority
**Priority:** Medium | **Backend:** Minor addition to existing PATCH endpoint

Currently `PATCH /v1/tickets/:id` only accepts `status` and `admin_response`. Add `priority` to the allowed fields for admin updates.

---

### 4.4 Internal Admin Notes
**Priority:** Medium | **Backend:** Schema addition + endpoint update

Add an `admin_notes` field to the `tickets` collection — visible only to admins, never sent to the user or included in user-facing API responses.

- `PATCH /v1/tickets/:id` — add optional `admin_notes: string` field.
- `GET /v1/tickets/:id` — include `admin_notes` only when caller is admin/owner.

---

### 4.5 Bulk Ticket Close
**Priority:** Low | **Backend:** Needs new endpoint

- `POST /v1/admin/tickets/bulk-close` — `{ ids: ['...', '...'], status: 'resolved' | 'closed' }`
- Sends closed notification email to each affected user.

---

## 5. Analytics & Reporting

### 5.1 Time-Series Request Analytics
**Priority:** High | **Backend:** Needs new endpoint

Current `/v1/usage` returns all-time aggregates only. Add time-bucketed analytics.

- `GET /v1/admin/analytics/requests` — query params: `from`, `to`, `bucket=hour|day`, `model?`, `user_email?`
- Returns array of `{ period, total, success, error, avg_latency_ms }` buckets.
- Uses MongoDB `$group` with `$dateTrunc` on `requests.created_at`.

---

### 5.2 Per-User Analytics
**Priority:** High | **Backend:** Needs new endpoint

Drill down into one user's usage from the admin side.

- `GET /v1/admin/users/:email/analytics` — same shape as `/v1/usage` but always scoped to the specified user regardless of caller identity.
- Includes quota position: plan, used today, limit, percent.

---

### 5.3 Error Analytics
**Priority:** Medium | **Backend:** Needs new endpoint

- `GET /v1/admin/analytics/errors` — query params: `from`, `to`, `bucket=hour|day`, `type?`, `model?`
- Returns time-bucketed error counts by type (`429`, `503`, `timeout`, `other`).

---

### 5.4 On-Demand Daily Summary Email
**Priority:** Medium | **Backend:** Needs new endpoint

Trigger the daily summary email instantly without waiting for the scheduler.

- `POST /v1/admin/notifications/daily-summary` — computes today's stats and fires `notifyAdminDailySummary`.
- Returns the summary payload so it can also be rendered in the admin panel.

---

### 5.5 Log Purge
**Priority:** Medium | **Backend:** Needs new endpoint

- `DELETE /v1/admin/logs` — `{ older_than_days: 30 }` — deletes `requests` and `errors` documents older than the given threshold.
- Returns `{ deleted_requests: 5000, deleted_errors: 200 }`.

---

### 5.6 Log Export (CSV)
**Priority:** Low | **Backend:** Needs new endpoint

- `GET /v1/admin/logs/export?from=...&to=...&format=csv` — streams a CSV of the `requests` collection for the given date range.
- Response: `Content-Type: text/csv`, streamed (no in-memory buffering).

---

## 6. Alert & Notification Controls

### 6.1 View Active Alert Throttle State
**Priority:** High | **Backend:** Needs new endpoint

Currently there is no way to see which alerts are suppressed. Admin has no visibility into throttle state.

- `GET /v1/admin/alerts/throttle` — scans Redis for all `alert:*` keys and returns:
  ```json
  [
    { "key": "alert:no_keys",        "suppressed_until": "2024-01-15T10:35:00Z" },
    { "key": "alert:queue_backlog",  "suppressed_until": "2024-01-15T10:20:00Z" }
  ]
  ```

---

### 6.2 Clear Alert Throttle
**Priority:** High | **Backend:** Needs new endpoint

`clearAlertThrottle()` already exists in `alertThrottle.js` but is never called via API.

- `DELETE /v1/admin/alerts/throttle/:key` — clears a specific throttle key so the next occurrence sends immediately.
- `DELETE /v1/admin/alerts/throttle` — clears all alert throttles (nuclear option for after an incident).

---

### 6.3 Alert Threshold Configuration
**Priority:** High | **Backend:** Needs new endpoint

`QUEUE_BACKLOG_THRESHOLD` and `KEY_POOL_LOW_THRESHOLD` are env vars — cannot be changed at runtime. Move to Redis.

- `GET /v1/admin/alerts/config`
- `PATCH /v1/admin/alerts/config` — `{ queue_backlog_threshold: 50, key_pool_low_threshold: 3, failure_rate_threshold: 10, failure_rate_window_minutes: 5 }`
- Also exposes `failure_rate_threshold` which triggers `notifyAdminHighFailureRate` — this alert currently has no trigger anywhere in the codebase (gap identified in exploration).

---

### 6.4 High Failure Rate Alert — Wire Up the Trigger
**Priority:** High | **Backend:** Needs implementation

`notifyAdminHighFailureRate` is defined in `notifications.js` and has a full email template but is **never called**. The failure rate monitoring logic is missing entirely.

- In `src/services/gemini.js`, after each failed call, increment a Redis counter `failure_rate:<minute_bucket>`.
- Background job (every 1 min) reads the last N buckets, computes failure count in the window, and calls `notifyAdminHighFailureRate` if it exceeds the configured threshold.
- Counter TTL = window size + 1 min.

---

### 6.5 Send Test Email
**Priority:** Medium | **Backend:** Needs new endpoint

Verify email delivery is working without waiting for a real event.

- `POST /v1/admin/notifications/test` — sends a simple test email to `OWNER_EMAIL` and returns `{ sent: true }` or an error payload.

---

## 7. Queue Management

### 7.1 Pause / Resume Queue
**Priority:** High | **Backend:** Needs new endpoint

BullMQ supports `queue.pause()` and `queue.resume()`. Expose these.

- `POST /v1/queue/pause` — pauses the `gemini-batch` queue (no new jobs are picked up)
- `POST /v1/queue/resume` — resumes
- `GET /v1/queue/status` — add `paused: true | false` to the existing response

---

### 7.2 Drain / Clear Failed Jobs
**Priority:** Medium | **Backend:** Needs new endpoint

- `DELETE /v1/queue/failed` — removes all permanently failed jobs from BullMQ.
- `DELETE /v1/queue/completed` — removes all completed jobs (frees Redis memory).

---

### 7.3 Retry Specific Job
**Priority:** Medium | **Backend:** Needs new endpoint

Currently `POST /v1/queue/retry` retries ALL failed jobs. Add single-job retry.

- `POST /v1/queue/jobs/:jobId/retry`

---

## 8. System Health & Observability

### 8.1 Comprehensive System Health Endpoint
**Priority:** High | **Backend:** Needs new endpoint

Single endpoint for a full system snapshot — intended to power an admin dashboard home screen.

- `GET /v1/admin/system/health` — returns:
  ```json
  {
    "services": {
      "redis":   { "status": "ok" },
      "mongodb": { "status": "ok" },
      "gemini":  { "status": "degraded", "active_keys": 2, "cooldown_keys": 6 }
    },
    "queue":  { "waiting": 0, "active": 3, "failed": 1, "paused": false },
    "keys":   { "active": 2, "cooldown": 6, "disabled": 1 },
    "alerts": { "suppressed_count": 2 },
    "maintenance_mode": false,
    "generation_enabled": true,
    "registration_enabled": true
  }
  ```

---

### 8.2 Redis Memory Stats
**Priority:** Low | **Backend:** Needs new endpoint

- `GET /v1/admin/system/redis-stats` — calls `redis.info('memory')` and returns `{ used_memory_human, maxmemory_human, mem_fragmentation_ratio }`.

---

### 8.3 Audit Log
**Priority:** Medium | **Backend:** Needs new MongoDB collection + middleware

Record sensitive admin actions with who did what and when. Written fire-and-forget.

New collection: `audit_log`
- Fields: `admin_email`, `action`, `target` (e.g. user email / key / ticket id), `details` (JSON diff), `ip`, `timestamp`
- Actions to log: block/unblock user, role change, plan change, key disable, maintenance mode toggle, whitelist change.
- `GET /v1/admin/audit-log` — paginated; filterable by `admin_email`, `action`, `from`, `to`.

---

## 9. Model Configuration (Admin Panel Exposure)

The following already exist as API routes but need to be surfaced in the admin panel UI. No backend changes needed.

| Feature | Existing Route |
|---------|---------------|
| View primary model + fallback chain | `GET /v1/models/config` |
| Change primary model | `PATCH /v1/models/config` |
| Add model to fallback chain | `POST /v1/models/config/fallback` |
| Remove model from fallback chain | `DELETE /v1/models/config/fallback/:name` |
| View model health stats | `GET /v1/models` |
| Reset model health counters | `PATCH /v1/models/:name` (action: "reset") |
| Test a model live | `POST /v1/debug/test-model` |

---

## 10. Security Enhancements

### 10.1 Login Attempt Rate Limiting
**Priority:** High | **Backend:** Needs middleware addition

`POST /auth/login` (OTP request) has no rate limiting. A bad actor can trigger unlimited OTP emails.

- Add Redis-based rate limit: max **5 OTP requests per email per hour**, max **20 requests per IP per hour**.
- Returns `429` with `Retry-After` header on exceed.

---

### 10.2 IP Blocklist
**Priority:** Medium | **Backend:** Needs new endpoint + middleware

- `GET /v1/admin/security/blocked-ips`
- `POST /v1/admin/security/blocked-ips` — `{ ip: '1.2.3.4', reason?: '...' }`
- `DELETE /v1/admin/security/blocked-ips/:ip`
- Early middleware checks request IP against Redis set `security:blocked_ips` and returns `403` immediately.

---

### 10.3 CORS Origins Management
**Priority:** Low | **Backend:** Needs new endpoint

`CORS_ORIGINS` is an env var requiring restart to change. Move to Redis.

- `GET /v1/admin/security/cors-origins`
- `POST /v1/admin/security/cors-origins` — `{ origin: 'https://app.example.com' }`
- `DELETE /v1/admin/security/cors-origins/:origin`
- Fastify CORS plugin reads allowed origins from Redis (with 60 s cache) instead of env var.

---

## Priority Summary

| Priority | Features |
|----------|----------|
| **High** | Maintenance mode, generation toggle, registration toggle, email whitelist, plan limits API, user search/filter, user stats, bulk key ops, clear cooldowns, key pool snapshot, ticket filtering, ticket stats, time-series analytics, per-user analytics, alert throttle visibility, alert throttle clear, alert threshold config, failure rate alert wiring, queue pause/resume, system health endpoint, login rate limiting |
| **Medium** | Default rate limit config, Gemini params config, bulk user ops, ticket priority update, internal admin notes, error analytics, on-demand summary email, log purge, send test email, queue drain, audit log, IP blocklist |
| **Low** | Key auto-rotation, ticket bulk-close, log CSV export, impersonate user, Redis memory stats, CORS management |

---

## Implementation Notes

1. **All new admin endpoints** should be registered under the existing `requireAdmin` preHandler scope in `server.js` — no new auth logic needed.
2. **All Redis-stored config values** should fall back to env vars / `config.js` defaults if the Redis key is absent, so existing deployments continue working without migration.
3. **The failure rate alert** (§6.4) is the only gap where a notification exists end-to-end (template + notifications.js function) but the trigger is completely missing — this should be prioritized.
4. **Alert throttle clear** (§6.2) reuses the existing `clearAlertThrottle()` function that was already written but never exposed.
