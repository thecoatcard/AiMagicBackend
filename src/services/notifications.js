/**
 * Notification dispatch layer. (Updated to call Frontend Email API)
 *
 * All exports are fire-and-forget — they never throw.
 * Call them after a successful DB write; don't await them on the hot path.
 */

import { sendEmail } from './email.js';
import { shouldSendAlert } from './alertThrottle.js';
import { config } from '../config.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function fire(promise) {
  Promise.resolve(promise).catch(() => {}); // swallow all errors
}

function send(to, template, data = {}) {
  fire(sendEmail(to, template, data));
}

function sendAdmin(template, data = {}) {
  if (!config.ownerEmail) return; // no owner configured — skip silently
  send(config.ownerEmail, template, data);
}

// ─── USER NOTIFICATIONS ───────────────────────────────────────────────────────

/** Sent when a new device/session signs in, to the previous session's owner. */
export function notifyNewDeviceLogin(email) {
  send(email, 'newDeviceLogin', { email });
}

/** Sent when a user is kicked out because their account signed in elsewhere. */
export function notifySessionInvalidated(email) {
  send(email, 'sessionInvalidated', { email });
}

/** Sent when an admin blocks a user's account. */
export function notifyAccountBlocked(email) {
  send(email, 'accountBlocked', { email });
}

/** Sent when an admin reinstates a blocked account. */
export function notifyAccountUnblocked(email) {
  send(email, 'accountUnblocked', { email });
}

/**
 * Sent when an admin changes a user's plan.
 */
export function notifyPlanChanged(email, { oldPlan, newPlan, newLimit }) {
  const PLAN_ORDER = ['free', 'premium'];
  const isUpgrade = PLAN_ORDER.indexOf(newPlan) > PLAN_ORDER.indexOf(oldPlan);
  send(email, 'planChanged', { email, oldPlan, newPlan, newLimit, isUpgrade });
}

/**
 * Sent to the user when their ticket is successfully created.
 */
export function notifyTicketCreated(email, { ticketId, subject, priority, description }) {
  send(email, 'ticketCreated', { email, ticketId, subject, priority, description });
}

/**
 * Sent to the user when an admin posts a response to their ticket.
 */
export function notifyTicketReply(email, { ticketId, subject, adminResponse, status }) {
  send(email, 'ticketReply', { ticketId, subject, adminResponse, status });
}

/**
 * Sent to the user when their ticket is resolved or closed.
 */
export function notifyTicketClosed(email, { ticketId, subject, status }) {
  send(email, 'ticketClosed', { ticketId, subject, status });
}

/**
 * Sent when a user hits 80% or 100% of their daily quota.
 */
export function notifyQuotaWarning(email, { used, limit, resetInSeconds }) {
  const percent = Math.floor((used / limit) * 100);
  if (percent < 80) return;

  const level = percent >= 100 ? '100' : '80';
  const throttleKey = `alert:quota:${email}:${level}`;
  const ttlS = Math.min(resetInSeconds > 0 ? resetInSeconds : 86400, 86400);

  shouldSendAlert(throttleKey, ttlS).then(ok => {
    if (!ok) return;
    send(email, 'quotaWarning', { used, limit, percent, resetInSeconds });
  }).catch(() => {});
}

// ─── ADMIN NOTIFICATIONS ──────────────────────────────────────────────────────

/**
 * Sent to the owner when a new support ticket is created.
 */
export function notifyAdminNewTicket(opts) {
  sendAdmin('adminNewTicket', opts);
}

/**
 * Sent when getKey() returns null — all keys are on cooldown or disabled.
 */
export function notifyAdminNoKeys() {
  shouldSendAlert('alert:no_keys', 600).then(ok => {
    if (!ok) return;
    sendAdmin('adminNoKeys', {});
  }).catch(() => {});
}

/**
 * Sent when the failure rate exceeds a threshold.
 */
export function notifyAdminHighFailureRate(opts) {
  shouldSendAlert('alert:high_failure_rate', 900).then(ok => {
    if (!ok) return;
    sendAdmin('adminHighFailureRate', opts);
  }).catch(() => {});
}

/**
 * Sent when the queue backlog exceeds a threshold.
 */
export function notifyAdminQueueBacklog(opts) {
  shouldSendAlert('alert:queue_backlog', 900).then(ok => {
    if (!ok) return;
    sendAdmin('adminQueueBacklog', opts);
  }).catch(() => {});
}

/**
 * Sent when a BullMQ job permanently fails.
 */
export function notifyAdminWorkerFailure(opts) {
  sendAdmin('adminWorkerFailure', opts);
}

/**
 * Sent when a key is disabled.
 */
export function notifyAdminKeyDisabled(opts) {
  const { maskedKey } = opts;
  shouldSendAlert(`alert:key_disabled:${maskedKey}`, 3600).then(ok => {
    if (!ok) return;
    sendAdmin('adminKeyDisabled', opts);
  }).catch(() => {});
}

/**
 * Sent when a key accumulates many 429 responses.
 */
export function notifyAdminKeyHighRateLimit(opts) {
  const { maskedKey } = opts;
  shouldSendAlert(`alert:key_429:${maskedKey}`, 1800).then(ok => {
    if (!ok) return;
    sendAdmin('adminKeyHighRateLimit', opts);
  }).catch(() => {});
}

/**
 * Sent when the active key pool drops below a threshold.
 */
export function notifyAdminKeyPoolLow(opts) {
  shouldSendAlert('alert:key_pool_low', 1800).then(ok => {
    if (!ok) return;
    sendAdmin('adminKeyPoolLow', opts);
  }).catch(() => {});
}

/**
 * Daily summary.
 */
export function notifyAdminDailySummary(opts) {
  sendAdmin('adminDailySummary', opts);
}
