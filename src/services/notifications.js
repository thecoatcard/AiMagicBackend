/**
 * Notification dispatch layer.
 *
 * All exports are fire-and-forget — they never throw.
 * Call them after a successful DB write; don't await them on the hot path.
 *
 * User notifications go to the user's own email.
 * Admin notifications go to the owner email from config.
 * Noisy admin alerts are debounced via Redis (shouldSendAlert).
 */

import { sendEmail } from './email.js';
import { shouldSendAlert } from './alertThrottle.js';
import { config } from '../config.js';
import {
  newDeviceLoginTemplate,
  sessionInvalidatedTemplate,
  accountBlockedTemplate,
  accountUnblockedTemplate,
  planChangedTemplate,
  ticketCreatedTemplate,
  ticketReplyTemplate,
  ticketClosedTemplate,
  quotaWarningTemplate,
  adminNewTicketTemplate,
  adminNoKeysTemplate,
  adminHighFailureRateTemplate,
  adminQueueBacklogTemplate,
  adminWorkerFailureTemplate,
  adminKeyDisabledTemplate,
  adminKeyHighRateLimitTemplate,
  adminKeyPoolLowTemplate,
  adminDailySummaryTemplate,
} from './emailTemplates.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function fire(promise) {
  Promise.resolve(promise).catch(() => {}); // swallow all errors
}

function send(to, tpl) {
  fire(sendEmail(to, tpl));
}

function sendAdmin(tpl) {
  if (!config.ownerEmail) return; // no owner configured — skip silently
  send(config.ownerEmail, tpl);
}

// ─── USER NOTIFICATIONS ───────────────────────────────────────────────────────

/** Sent when a new device/session signs in, to the previous session's owner. */
export function notifyNewDeviceLogin(email) {
  send(email, newDeviceLoginTemplate({ email }));
}

/** Sent when a user is kicked out because their account signed in elsewhere. */
export function notifySessionInvalidated(email) {
  send(email, sessionInvalidatedTemplate({ email }));
}

/** Sent when an admin blocks a user's account. */
export function notifyAccountBlocked(email) {
  send(email, accountBlockedTemplate({ email }));
}

/** Sent when an admin reinstates a blocked account. */
export function notifyAccountUnblocked(email) {
  send(email, accountUnblockedTemplate({ email }));
}

/**
 * Sent when an admin changes a user's plan.
 * @param {string} email
 * @param {{ oldPlan: string, newPlan: string, newLimit: number }} opts
 */
export function notifyPlanChanged(email, { oldPlan, newPlan, newLimit }) {
  const PLAN_ORDER = ['free', 'premium']; // lower index = lower tier
  const isUpgrade = PLAN_ORDER.indexOf(newPlan) > PLAN_ORDER.indexOf(oldPlan);
  send(email, planChangedTemplate({ email, oldPlan, newPlan, newLimit, isUpgrade }));
}

/**
 * Sent to the user when their ticket is successfully created.
 * @param {string} email
 * @param {{ ticketId: string, subject: string, priority: string, description: string }} opts
 */
export function notifyTicketCreated(email, { ticketId, subject, priority, description }) {
  send(email, ticketCreatedTemplate({ email, ticketId, subject, priority, description }));
}

/**
 * Sent to the user when an admin posts a response to their ticket.
 * @param {string} email
 * @param {{ ticketId: string, subject: string, adminResponse: string, status: string }} opts
 */
export function notifyTicketReply(email, { ticketId, subject, adminResponse, status }) {
  send(email, ticketReplyTemplate({ ticketId, subject, adminResponse, status }));
}

/**
 * Sent to the user when their ticket is resolved or closed.
 * @param {string} email
 * @param {{ ticketId: string, subject: string, status: string }} opts
 */
export function notifyTicketClosed(email, { ticketId, subject, status }) {
  send(email, ticketClosedTemplate({ ticketId, subject, status }));
}

/**
 * Sent when a user hits 80% or 100% of their daily quota.
 * The Redis throttle inside this function ensures we send at most once per
 * threshold crossing per day.
 *
 * @param {string} email
 * @param {{ used: number, limit: number, resetInSeconds: number }} opts
 */
export function notifyQuotaWarning(email, { used, limit, resetInSeconds }) {
  const percent = Math.floor((used / limit) * 100);
  if (percent < 80) return; // not yet at warning level

  const level = percent >= 100 ? '100' : '80';
  const throttleKey = `alert:quota:${email}:${level}`;
  // Throttle within the current quota window (reset time), capped at 24h
  const ttlS = Math.min(resetInSeconds > 0 ? resetInSeconds : 86400, 86400);

  shouldSendAlert(throttleKey, ttlS).then(ok => {
    if (!ok) return;
    send(email, quotaWarningTemplate({ used, limit, percent, resetInSeconds }));
  }).catch(() => {});
}

// ─── ADMIN NOTIFICATIONS ──────────────────────────────────────────────────────

/**
 * Sent to the owner when a new support ticket is created.
 * @param {{ ticketId: string, userEmail: string, subject: string, priority: string, description: string }} opts
 */
export function notifyAdminNewTicket({ ticketId, userEmail, subject, priority, description }) {
  sendAdmin(adminNewTicketTemplate({ ticketId, userEmail, subject, priority, description }));
}

/**
 * Sent when getKey() returns null — all keys are on cooldown or disabled.
 * Throttled to once per 10 minutes to avoid alert storms.
 */
export function notifyAdminNoKeys() {
  shouldSendAlert('alert:no_keys', 600).then(ok => {
    if (!ok) return;
    sendAdmin(adminNoKeysTemplate());
  }).catch(() => {});
}

/**
 * Sent when the failure rate exceeds a threshold.
 * Caller tracks the window; this function just sends with a 15-min throttle.
 * @param {{ failureCount: number, timeWindowMinutes: number, threshold: number }} opts
 */
export function notifyAdminHighFailureRate({ failureCount, timeWindowMinutes, threshold }) {
  shouldSendAlert('alert:high_failure_rate', 900).then(ok => {
    if (!ok) return;
    sendAdmin(adminHighFailureRateTemplate({ failureCount, timeWindowMinutes, threshold }));
  }).catch(() => {});
}

/**
 * Sent when the queue backlog exceeds a threshold.
 * Throttled to once per 15 minutes.
 * @param {{ queueSize: number, threshold: number }} opts
 */
export function notifyAdminQueueBacklog({ queueSize, threshold }) {
  shouldSendAlert('alert:queue_backlog', 900).then(ok => {
    if (!ok) return;
    sendAdmin(adminQueueBacklogTemplate({ queueSize, threshold }));
  }).catch(() => {});
}

/**
 * Sent when a BullMQ job permanently fails (all retries exhausted).
 * No throttle — every permanent failure should be reported.
 * @param {{ jobId: string, error: string, attempts: number }} opts
 */
export function notifyAdminWorkerFailure({ jobId, error, attempts }) {
  sendAdmin(adminWorkerFailureTemplate({ jobId, error, attempts }));
}

/**
 * Sent when a key is disabled via API or automatic policy.
 * Throttled per key to once per hour.
 * @param {{ maskedKey: string }} opts
 */
export function notifyAdminKeyDisabled({ maskedKey }) {
  shouldSendAlert(`alert:key_disabled:${maskedKey}`, 3600).then(ok => {
    if (!ok) return;
    sendAdmin(adminKeyDisabledTemplate({ maskedKey }));
  }).catch(() => {});
}

/**
 * Sent when a key accumulates many 429 responses in a short window.
 * Throttled per key to once per 30 minutes.
 * @param {{ maskedKey: string, count429: number, windowMinutes: number }} opts
 */
export function notifyAdminKeyHighRateLimit({ maskedKey, count429, windowMinutes }) {
  shouldSendAlert(`alert:key_429:${maskedKey}`, 1800).then(ok => {
    if (!ok) return;
    sendAdmin(adminKeyHighRateLimitTemplate({ maskedKey, count429, windowMinutes }));
  }).catch(() => {});
}

/**
 * Sent when the active key pool drops below a threshold.
 * Throttled to once per 30 minutes.
 * @param {{ activeCount: number, threshold: number }} opts
 */
export function notifyAdminKeyPoolLow({ activeCount, threshold }) {
  shouldSendAlert('alert:key_pool_low', 1800).then(ok => {
    if (!ok) return;
    sendAdmin(adminKeyPoolLowTemplate({ activeCount, threshold }));
  }).catch(() => {});
}

/**
 * Daily summary — called once per day from the scheduler in index.js.
 * No throttle; the scheduler itself ensures once-per-day delivery.
 * @param {{ date: string, totalRequests: number, successRequests: number, errorRequests: number, avgLatencyMs: number, maxLatencyMs: number, activeKeys: number, totalUsers: number, topModel: string|null }} opts
 */
export function notifyAdminDailySummary(opts) {
  sendAdmin(adminDailySummaryTemplate(opts));
}
