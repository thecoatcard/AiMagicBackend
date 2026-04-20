/**
 * Notification dispatch layer. (Updated to call Frontend Email API)
 *
 * All exports are fire-and-forget — they never throw.
 * Call them after a successful DB write; don't await them on the hot path.
 */

import { sendEmail } from './email.js';
import { shouldSendAlert } from './alertThrottle.js';
import { config } from '../config.js';
import { getSystemConfig } from '../redis/systemConfig.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function fire(promise) {
  Promise.resolve(promise).catch(err => {
    console.warn('[notifications] Failed to send notification:', err.message);
  });
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
export async function notifyNewDeviceLogin(email) {
  if (await getSystemConfig('email_security_enabled') === '0') return;
  send(email, 'newDeviceLogin', { email });
}

/** Sent when a user is kicked out because their account signed in elsewhere. */
export async function notifySessionInvalidated(email) {
  if (await getSystemConfig('email_security_enabled') === '0') return;
  send(email, 'sessionInvalidated', { email });
}

/** Sent when an admin blocks a user's account. */
export async function notifyAccountBlocked(email) {
  if (await getSystemConfig('email_status_enabled') === '0') return;
  send(email, 'accountBlocked', { email });
}

/** Sent when an admin reinstates a blocked account. */
export async function notifyAccountUnblocked(email) {
  if (await getSystemConfig('email_status_enabled') === '0') return;
  send(email, 'accountUnblocked', { email });
}

/**
 * Sent when an admin changes a user's plan.
 */
export async function notifyPlanChanged(email, { oldPlan, newPlan, newLimit }) {
  if (await getSystemConfig('email_status_enabled') === '0') return;
  const PLAN_ORDER = ['free', 'premium'];
  const isUpgrade = PLAN_ORDER.indexOf(newPlan) > PLAN_ORDER.indexOf(oldPlan);
  send(email, 'planChanged', { email, oldPlan, newPlan, newLimit, isUpgrade });
}

/**
 * Sent to the user when their ticket is successfully created.
 */
export async function notifyTicketCreated(email, { ticketId, subject, priority, description }) {
  if (await getSystemConfig('email_tickets_enabled') === '0') return;
  send(email, 'ticketCreated', { email, ticketId, subject, priority, description });
}

/**
 * Sent to the user when an admin posts a response to their ticket.
 */
export async function notifyTicketReply(email, { ticketId, subject, adminResponse, status }) {
  if (await getSystemConfig('email_tickets_enabled') === '0') return;
  send(email, 'ticketReply', { ticketId, subject, adminResponse, status });
}

/**
 * Sent to the user when their ticket is resolved or closed.
 */
export async function notifyTicketClosed(email, { ticketId, subject, status }) {
  if (await getSystemConfig('email_tickets_enabled') === '0') return;
  send(email, 'ticketClosed', { ticketId, subject, status });
}

/**
 * Sent when a user hits 80% or 100% of their daily quota.
 */
export async function notifyQuotaWarning(email, { used, limit, resetInSeconds }) {
  if (await getSystemConfig('email_quota_enabled') === '0') return;

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
export async function notifyAdminNewTicket(opts) {
  if (await getSystemConfig('email_tickets_enabled') === '0') return;
  sendAdmin('adminNewTicket', opts);
}

/**
 * Sent when getKey() returns null — all keys are on cooldown or disabled.
 */
export async function notifyAdminNoKeys() {
  if (await getSystemConfig('email_admin_alerts_enabled') === '0') return;
  shouldSendAlert('alert:no_keys', 600).then(ok => {
    if (!ok) return;
    sendAdmin('adminNoKeys', {});
  }).catch(() => {});
}

/**
 * Sent when the failure rate exceeds a threshold.
 */
export async function notifyAdminHighFailureRate(opts) {
  if (await getSystemConfig('email_admin_alerts_enabled') === '0') return;
  shouldSendAlert('alert:high_failure_rate', 900).then(ok => {
    if (!ok) return;
    sendAdmin('adminHighFailureRate', opts);
  }).catch(() => {});
}

/**
 * Sent when the queue backlog exceeds a threshold.
 */
export async function notifyAdminQueueBacklog(opts) {
  if (await getSystemConfig('email_admin_alerts_enabled') === '0') return;
  shouldSendAlert('alert:queue_backlog', 900).then(ok => {
    if (!ok) return;
    sendAdmin('adminQueueBacklog', opts);
  }).catch(() => {});
}

/**
 * Sent when a BullMQ job permanently fails.
 */
export async function notifyAdminWorkerFailure(opts) {
  if (await getSystemConfig('email_admin_alerts_enabled') === '0') return;
  sendAdmin('adminWorkerFailure', opts);
}

/**
 * Sent when a key is disabled.
 */
export async function notifyAdminKeyDisabled(opts) {
  if (await getSystemConfig('email_admin_alerts_enabled') === '0') return;
  const { maskedKey } = opts;
  shouldSendAlert(`alert:key_disabled:${maskedKey}`, 3600).then(ok => {
    if (!ok) return;
    sendAdmin('adminKeyDisabled', opts);
  }).catch(() => {});
}

/**
 * Sent when a key accumulates many 429 responses.
 */
export async function notifyAdminKeyHighRateLimit(opts) {
  if (await getSystemConfig('email_admin_alerts_enabled') === '0') return;
  const { maskedKey } = opts;
  shouldSendAlert(`alert:key_429:${maskedKey}`, 1800).then(ok => {
    if (!ok) return;
    sendAdmin('adminKeyHighRateLimit', opts);
  }).catch(() => {});
}

/**
 * Sent when the active key pool drops below a threshold.
 */
export async function notifyAdminKeyPoolLow(opts) {
  if (await getSystemConfig('email_admin_alerts_enabled') === '0') return;
  shouldSendAlert('alert:key_pool_low', 1800).then(ok => {
    if (!ok) return;
    sendAdmin('adminKeyPoolLow', opts);
  }).catch(() => {});
}

/**
 * Daily summary.
 */
export async function notifyAdminDailySummary(opts) {
  if (await getSystemConfig('email_admin_alerts_enabled') === '0') return;
  sendAdmin('adminDailySummary', opts);
}
