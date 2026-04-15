/**
 * HTML email templates for Gemini Proxy.
 * Each export returns { subject, html, text }.
 * All templates use inline styles for maximum email-client compatibility.
 */

// ─── Design tokens ───────────────────────────────────────────────────────────
const C = {
  brand: '#4f46e5',
  dark: '#0f172a',
  success: '#16a34a',
  danger: '#dc2626',
  warning: '#d97706',
  info: '#2563eb',
  muted: '#64748b',
  border: '#e2e8f0',
  bg: '#f8fafc',
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(body, { headerBg = C.dark, badge = '', badgeColor = C.brand } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Gemini Proxy</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px;">
  <tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

    <!-- Header -->
    <tr>
      <td style="background:${headerBg};padding:22px 32px;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td>
            <span style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:-0.3px;">⚡ Gemini Proxy</span>
          </td>
          ${badge ? `<td align="right"><span style="background:${badgeColor}22;color:#fff;font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;border:1px solid ${badgeColor}66;letter-spacing:0.4px;">${badge}</span></td>` : ''}
        </tr></table>
      </td>
    </tr>

    <!-- Body -->
    <tr>
      <td style="padding:32px 36px;">
        ${body}
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="padding:18px 36px;background:#f8fafc;border-top:1px solid #f1f5f9;">
        <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
          This is an automated notification from Gemini Proxy. Do not reply to this email.
        </p>
      </td>
    </tr>

  </table>
  </td></tr>
</table>
</body>
</html>`;
}

function h1(title, sub = '') {
  return `<h1 style="margin:0 0 ${sub ? '6' : '20'}px 0;color:${C.dark};font-size:22px;font-weight:700;line-height:1.3;">${esc(title)}</h1>
  ${sub ? `<p style="margin:0 0 24px 0;color:${C.muted};font-size:14px;line-height:1.5;">${esc(sub)}</p>` : ''}`;
}

function chip(text, color) {
  return `<span style="display:inline-block;background:${color}18;color:${color};font-size:12px;font-weight:600;padding:2px 10px;border-radius:20px;border:1px solid ${color}33;">${esc(text)}</span>`;
}

function kv(label, valueHtml) {
  return `<tr>
    <td style="padding:7px 0;color:${C.muted};font-size:13px;width:150px;vertical-align:top;white-space:nowrap;">${esc(label)}</td>
    <td style="padding:7px 0;color:${C.dark};font-size:13px;font-weight:500;vertical-align:top;">${valueHtml}</td>
  </tr>`;
}

function notice(html, type = 'warning') {
  const map = {
    warning: { bg: '#fffbeb', border: '#fcd34d', icon: '⚠️' },
    danger: { bg: '#fef2f2', border: '#fca5a5', icon: '🚨' },
    info: { bg: '#eff6ff', border: '#93c5fd', icon: 'ℹ️' },
    success: { bg: '#f0fdf4', border: '#86efac', icon: '✅' },
  };
  const s = map[type] ?? map.info;
  return `<div style="background:${s.bg};border:1px solid ${s.border};border-radius:8px;padding:14px 18px;margin:20px 0;font-size:14px;color:#374151;line-height:1.6;">${s.icon}&ensp;${html}</div>`;
}

function box(html, bg = '#f8fafc', border = C.border) {
  return `<div style="background:${bg};border:1px solid ${border};border-radius:8px;padding:16px 20px;margin:16px 0;font-size:14px;color:#374151;line-height:1.6;">${html}</div>`;
}

function code(str) {
  return `<code style="font-family:'Courier New',Consolas,monospace;background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:12px;">${esc(str)}</code>`;
}

const hr = `<hr style="border:none;border-top:1px solid #f1f5f9;margin:24px 0;">`;

// ─── USER TEMPLATES ───────────────────────────────────────────────────────────

export function otpTemplate({ otp }) {
  const body = `
    ${h1('Your Login Code', 'Use the code below to sign in to your account.')}
    <div style="text-align:center;margin:28px 0;">
      <div style="display:inline-block;background:#f8fafc;border:2px dashed #e2e8f0;border-radius:12px;padding:20px 44px;">
        <span style="font-size:44px;font-weight:800;letter-spacing:14px;color:${C.dark};font-family:'Courier New',monospace;">${esc(otp)}</span>
      </div>
    </div>
    ${notice('This code expires in <strong>10 minutes</strong>. Never share it with anyone — our team will never ask for it.', 'warning')}
    <p style="margin:16px 0 0;color:${C.muted};font-size:13px;">Didn't request this? You can safely ignore this email.</p>
  `;
  return {
    subject: `${otp} — your Gemini Proxy login code`,
    html: layout(body, { badge: 'Security', badgeColor: C.brand }),
    text: `Your Gemini Proxy login code: ${otp}\n\nExpires in 10 minutes. Do not share this code.`,
  };
}

export function newDeviceLoginTemplate({ email }) {
  const body = `
    ${h1('New Sign-In Detected', 'Your account was accessed from a new session.')}
    ${box(`A successful sign-in was detected for <strong>${esc(email)}</strong>.`)}
    ${notice('If you did <strong>not</strong> sign in just now, your account may be compromised. Contact support immediately and change your email password.', 'danger')}
  `;
  return {
    subject: 'New sign-in to your Gemini Proxy account',
    html: layout(body, { headerBg: '#1e293b', badge: 'Security', badgeColor: '#7c3aed' }),
    text: `New sign-in detected for ${email}. If this wasn't you, contact support immediately.`,
  };
}

export function sessionInvalidatedTemplate({ email }) {
  const body = `
    ${h1('New Sign-In & Previous Session Ended', 'A new sign-in was detected on your account.')}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${kv('Account', `<span style="color:${C.dark};">${esc(email)}</span>`)}
    </table>
    <div style="margin:0 0 12px;">
      <div style="display:flex;align-items:flex-start;gap:12px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px 18px;margin-bottom:10px;font-size:14px;color:#374151;line-height:1.6;">
        ✅&ensp;<span>A <strong>new sign-in</strong> was recorded for your account.</span>
      </div>
      <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:14px 18px;font-size:14px;color:#374151;line-height:1.6;">
        🔴&ensp;<span>Your <strong>previous session was automatically signed out</strong> because only one active session is allowed at a time.</span>
      </div>
    </div>
    ${notice('If you did <strong>not</strong> initiate this sign-in, your account may be compromised. Secure your email immediately and contact support.', 'danger')}
  `;
  return {
    subject: 'New sign-in detected — previous session ended',
    html: layout(body, { headerBg: '#1e293b', badge: 'Security', badgeColor: '#7c3aed' }),
    text: `New sign-in detected for ${email}. Your previous session was signed out. If this wasn't you, contact support immediately.`,
  };
}

export function accountBlockedTemplate({ email }) {
  const body = `
    ${h1('Account Suspended', 'Your access has been restricted by an administrator.')}
    ${notice(`Your account <strong>${esc(email)}</strong> has been suspended. All active sessions have been terminated.`, 'danger')}
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0;">If you believe this is a mistake, please contact support. You will not be able to sign in until the suspension is lifted.</p>
  `;
  return {
    subject: 'Your Gemini Proxy account has been suspended',
    html: layout(body, { headerBg: C.danger, badge: 'Account', badgeColor: '#991b1b' }),
    text: `Your Gemini Proxy account (${email}) has been suspended. Contact support if you believe this is a mistake.`,
  };
}

export function accountUnblockedTemplate({ email }) {
  const body = `
    ${h1('Account Restored ✓', 'Your access has been reinstated.')}
    ${box(`Great news! Your account <strong>${esc(email)}</strong> has been fully restored. You can now sign in normally.`, '#f0fdf4', '#86efac')}
    <p style="color:${C.muted};font-size:13px;margin:16px 0 0;">If you have any questions, feel free to open a support ticket.</p>
  `;
  return {
    subject: 'Your Gemini Proxy account has been restored',
    html: layout(body, { headerBg: C.success, badge: 'Account', badgeColor: '#14532d' }),
    text: `Your Gemini Proxy account (${email}) has been restored. You can sign in normally.`,
  };
}

export function planChangedTemplate({ email, oldPlan, newPlan, newLimit, isUpgrade }) {
  const planLabel = { free: 'Free', premium: 'Premium' };
  const body = `
    ${h1(isUpgrade ? 'Plan Upgraded 🎉' : 'Plan Updated', isUpgrade ? `Welcome to ${planLabel[newPlan] ?? newPlan}!` : 'Your plan has been adjusted.')}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${kv('Account', `<span style="color:${C.dark};">${esc(email)}</span>`)}
      ${kv('Previous plan', chip(planLabel[oldPlan] ?? oldPlan, C.muted))}
      ${kv('New plan', chip(planLabel[newPlan] ?? newPlan, isUpgrade ? C.success : C.warning))}
      ${kv('Daily limit', `<strong>${newLimit.toLocaleString()} requests / day</strong>`)}
    </table>
    ${
      isUpgrade
        ? notice('Your increased quota is active immediately. Enjoy the extra capacity!', 'success')
        : notice(`Your daily limit has been adjusted to <strong>${newLimit.toLocaleString()} requests</strong> per day, effective immediately.`, 'warning')
  }
  `;
  return {
    subject: isUpgrade ? `Your plan was upgraded to ${ planLabel[newPlan] ?? newPlan } ` : 'Your Gemini Proxy plan has been updated',
    html: layout(body, { headerBg: isUpgrade ? C.success : C.dark, badge: 'Plan Update', badgeColor: isUpgrade ? '#14532d' : C.warning }),
    text: `Your Gemini Proxy plan changed: ${ oldPlan } → ${ newPlan }. New daily limit: ${ newLimit } requests / day.`,
  };
}

export function ticketCreatedTemplate({ email, ticketId, subject, priority, description }) {
  const pColor = { low: C.muted, medium: C.warning, high: C.danger };
  const body = `
    ${ h1('Support Ticket Created', 'We received your request and will respond shortly.') }
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
    ${kv('Ticket ID', code(ticketId.slice(-8).toUpperCase()))}
    ${kv('Subject', `<span style="color:${C.dark};font-weight:600;">${esc(subject)}</span>`)}
    ${kv('Priority', chip(priority, pColor[priority] ?? C.muted))}
    ${kv('Status', chip('open', C.info))}
  </table>
    ${ hr }
    <p style="color:${C.muted};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin:0 0 10px;">Your message</p>
    <div style="background:#f8fafc;border-radius:8px;padding:16px 20px;font-size:14px;color:#374151;line-height:1.7;white-space:pre-wrap;">${esc(description)}</div>
    <p style="color:${C.muted};font-size:13px;margin:20px 0 0;">You'll be notified by email when our team responds.</p>
  `;
  return {
    subject: `[Ticket #${ ticketId.slice(-6).toUpperCase() }] ${ subject } `,
    html: layout(body, { badge: 'Support', badgeColor: C.brand }),
    text: `Support ticket created.\n\nTicket ID: ${ ticketId } \nSubject: ${ subject } \nPriority: ${ priority } \n\n${ description } `,
  };
}

export function ticketReplyTemplate({ ticketId, subject, adminResponse, status }) {
  const statusColor = { open: C.warning, in_progress: C.info, resolved: C.success, closed: C.muted };
  const body = `
    ${ h1('Response to Your Ticket', `An administrator replied to: ${subject}`) }
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
    ${kv('Ticket ID', code(ticketId.slice(-8).toUpperCase()))}
    ${kv('Subject', `<span style="color:${C.dark};font-weight:600;">${esc(subject)}</span>`)}
    ${kv('Status', chip(status, statusColor[status] ?? C.info))}
  </table>
    ${ hr }
    <p style="color:${C.muted};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin:0 0 10px;">Admin response</p>
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px 20px;font-size:14px;color:#1e3a5f;line-height:1.7;white-space:pre-wrap;">${esc(adminResponse)}</div>
    <p style="color:${C.muted};font-size:13px;margin:20px 0 0;">You can view the full ticket history in your dashboard.</p>
  `;
  return {
    subject: `Re: [Ticket #${ ticketId.slice(-6).toUpperCase() }] ${ subject } `,
    html: layout(body, { badge: 'Support Reply', badgeColor: C.info }),
    text: `Admin replied to your ticket "${subject}".\n\n${ adminResponse } `,
  };
}

export function ticketClosedTemplate({ ticketId, subject, status }) {
  const isResolved = status === 'resolved';
  const body = `
    ${ h1(`Ticket ${status.charAt(0).toUpperCase() + status.slice(1)}`, isResolved ? 'Your issue has been resolved.' : 'This ticket has been closed.') }
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
    ${kv('Ticket ID', code(ticketId.slice(-8).toUpperCase()))}
    ${kv('Subject', `<span style="color:${C.dark};font-weight:600;">${esc(subject)}</span>`)}
    ${kv('Final status', chip(status, isResolved ? C.success : C.muted))}
  </table>
    ${
    isResolved
      ? notice('We hope this resolved your issue. If you need further help, open a new ticket anytime.', 'success')
      : box('This ticket has been closed. If your issue persists, please open a new support ticket.')
  }
  `;
  return {
    subject: `[Ticket #${ ticketId.slice(-6).toUpperCase() }] ${ status.charAt(0).toUpperCase() + status.slice(1) } — ${ subject } `,
    html: layout(body, { headerBg: isResolved ? C.success : '#475569', badge: 'Support', badgeColor: isResolved ? '#14532d' : C.muted }),
    text: `Your support ticket "${subject}" has been ${ status }.`,
  };
}

export function quotaWarningTemplate({ used, limit, percent, resetInSeconds }) {
  const exhausted = percent >= 100;
  const remaining = Math.max(0, limit - used);
  const hours = Math.ceil(resetInSeconds / 3600);
  const barColor = exhausted ? C.danger : C.warning;
  const fillPct = Math.min(percent, 100);

  const body = `
    ${
    h1(
      exhausted ? '🚫 Daily Quota Exhausted' : '⚠️ Quota Warning',
      exhausted ? 'You have used all your requests for today.' : `You've used ${percent}% of your daily quota.`
    )
  }

    < !--Progress bar-- >
    <div style="margin:24px 0 8px;">
      <div style="background:#f1f5f9;border-radius:999px;height:10px;overflow:hidden;">
        <div style="background:${barColor};height:10px;width:${fillPct}%;border-radius:999px;"></div>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">
        <tr>
          <td style="color:${C.muted};font-size:12px;">${used.toLocaleString()} used</td>
          <td align="right" style="color:${C.muted};font-size:12px;">${limit.toLocaleString()} total</td>
        </tr>
      </table>
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${kv('Used today', `<strong style="color:${barColor};">${used.toLocaleString()}</strong>`)}
      ${kv('Daily limit', `${limit.toLocaleString()} requests`)}
      ${exhausted ? '' : kv('Remaining', `<strong>${remaining.toLocaleString()} requests</strong>`)}
      ${kv('Quota resets in', `~${hours} hour${hours !== 1 ? 's' : ''}`)}
    </table>

    ${
    exhausted
      ? notice('All requests are blocked until your quota resets. Contact support or upgrade your plan for higher limits.', 'danger')
      : notice(`Only <strong>${remaining.toLocaleString()} requests</strong> remaining today. Upgrade to Premium for 500 requests/day.`, 'warning')
  }
  `;
  return {
    subject: exhausted
      ? '🚫 Daily quota exhausted — Gemini Proxy'
      : `⚠️ Quota alert: ${ percent }% used today — Gemini Proxy`,
    html: layout(body, { headerBg: exhausted ? C.danger : C.warning, badge: 'Quota Alert', badgeColor: exhausted ? '#7f1d1d' : '#78350f' }),
    text: `Gemini Proxy quota: ${ used }/${limit} requests used today (${percent}%). Resets in ~${hours}h.`,
};
}

// ─── ADMIN TEMPLATES ──────────────────────────────────────────────────────────

export function adminNewTicketTemplate({ ticketId, userEmail, subject, priority, description }) {
  const pColor = { low: C.muted, medium: C.warning, high: C.danger };
  const body = `
    ${h1('New Support Ticket', 'A user needs your assistance.')}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${kv('Ticket ID', code(ticketId.slice(-8).toUpperCase()))}
      ${kv('From', `<a href="mailto:${esc(userEmail)}" style="color:${C.brand};">${esc(userEmail)}</a>`)}
      ${kv('Subject', `<strong>${esc(subject)}</strong>`)}
      ${kv('Priority', chip(priority, pColor[priority] ?? C.muted))}
      ${kv('Submitted', new Date().toUTCString())}
    </table>
    ${hr}
    <p style="color:${C.muted};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin:0 0 10px;">Message</p>
    <div style="background:#f8fafc;border-radius:8px;padding:16px 20px;font-size:14px;color:#374151;line-height:1.7;white-space:pre-wrap;">${esc(description)}</div>
  `;
  return {
    subject: `[Support] ${priority.toUpperCase()} — ${subject} (from ${userEmail})`,
    html: layout(body, { headerBg: '#1e293b', badge: 'New Ticket', badgeColor: pColor[priority] ?? C.muted }),
    text: `New support ticket\nFrom: ${userEmail}\nSubject: ${subject}\nPriority: ${priority}\n\n${description}`,
  };
}

export function adminNoKeysTemplate() {
  const body = `
    ${h1('🚨 No API Keys Available', 'All Gemini API keys are on cooldown or disabled.')}
    ${notice('<strong>All generation requests are currently failing with 503 NO_KEYS.</strong> Immediate action required.', 'danger')}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${kv('Detected at', new Date().toUTCString())}
      ${kv('Impact', 'All /v1/generate, /v1/stream, and /v1/generate/batch requests are blocked')}
    </table>
    <p style="color:#374151;font-size:14px;margin:0 0 10px;"><strong>Immediate actions:</strong></p>
    <ul style="color:#374151;font-size:14px;line-height:2;margin:0;padding-left:20px;">
      <li>Check pool: <code style="font-size:12px;background:#f1f5f9;padding:1px 5px;border-radius:3px;">GET /v1/keys</code></li>
      <li>Add new keys: <code style="font-size:12px;background:#f1f5f9;padding:1px 5px;border-radius:3px;">POST /v1/keys</code></li>
      <li>Re-enable cooled keys: <code style="font-size:12px;background:#f1f5f9;padding:1px 5px;border-radius:3px;">PATCH /v1/keys/:key/enable</code></li>
    </ul>
  `;
  return {
    subject: '🚨 CRITICAL: No Gemini API keys available — all requests failing',
    html: layout(body, { headerBg: C.danger, badge: 'CRITICAL', badgeColor: '#7f1d1d' }),
    text: `CRITICAL: All Gemini API keys exhausted. All generation requests are failing. Add new keys immediately.`,
  };
}

export function adminHighFailureRateTemplate({ failureCount, timeWindowMinutes, threshold }) {
  const body = `
    ${h1('⚠️ High Failure Rate', 'Gemini API requests are failing at an elevated rate.')}
    ${notice(`<strong>${failureCount} failures</strong> detected in the last ${timeWindowMinutes} minutes (alert threshold: ${threshold}).`, 'warning')}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${kv('Failures (window)', `${failureCount} in ${timeWindowMinutes} min`)}
      ${kv('Threshold', `${threshold} failures`)}
      ${kv('Detected at', new Date().toUTCString())}
    </table>
    <p style="color:#374151;font-size:14px;margin:0 0 10px;"><strong>Possible causes:</strong></p>
    <ul style="color:#374151;font-size:14px;line-height:2;margin:0;padding-left:20px;">
      <li>Gemini API outage or degraded performance</li>
      <li>Multiple keys hitting rate limits simultaneously</li>
      <li>Network connectivity issues to Google APIs</li>
    </ul>
  `;
  return {
    subject: `⚠️ High failure rate: ${failureCount} errors in ${timeWindowMinutes}min`,
    html: layout(body, { headerBg: C.warning, badge: 'System Alert', badgeColor: '#78350f' }),
    text: `High failure rate: ${failureCount} Gemini API failures in ${timeWindowMinutes} minutes. Check system status.`,
  };
}

export function adminQueueBacklogTemplate({ queueSize, threshold }) {
  const body = `
    ${h1('📦 Queue Backlog Alert', 'The batch job queue has grown beyond normal levels.')}
    ${notice(`<strong>${queueSize} jobs</strong> are currently waiting in the queue (alert threshold: ${threshold}).`, 'warning')}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${kv('Waiting jobs', `<strong style="font-size:18px;color:${C.warning};">${queueSize}</strong>`)}
      ${kv('Threshold', threshold)}
      ${kv('Detected at', new Date().toUTCString())}
    </table>
    <p style="color:#374151;font-size:14px;margin:0 0 10px;"><strong>Suggested actions:</strong></p>
    <ul style="color:#374151;font-size:14px;line-height:2;margin:0;padding-left:20px;">
      <li>Inspect queue: <code style="font-size:12px;background:#f1f5f9;padding:1px 5px;border-radius:3px;">GET /v1/queue/status</code></li>
      <li>Retry failed jobs: <code style="font-size:12px;background:#f1f5f9;padding:1px 5px;border-radius:3px;">POST /v1/queue/retry</code></li>
      <li>Increase <code style="font-size:12px;background:#f1f5f9;padding:1px 5px;border-radius:3px;">WORKER_CONCURRENCY</code> in .env</li>
    </ul>
  `;
  return {
    subject: `📦 Queue backlog: ${queueSize} jobs waiting`,
    html: layout(body, { badge: 'Queue Alert', badgeColor: C.warning }),
    text: `Queue backlog: ${queueSize} jobs waiting (threshold: ${threshold}). Check /v1/queue/status.`,
  };
}

export function adminWorkerFailureTemplate({ jobId, error, attempts }) {
  const body = `
    ${h1('🔧 Batch Job Permanently Failed', `Job exhausted all ${attempts} attempt${attempts !== 1 ? 's' : ''}.`)}
    ${notice(`Job <strong>${esc(jobId)}</strong> has permanently failed and will not be retried.`, 'danger')}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${kv('Job ID', code(jobId))}
      ${kv('Attempts made', `${attempts}`)}
      ${kv('Failed at', new Date().toUTCString())}
    </table>
    ${hr}
    <p style="color:${C.muted};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin:0 0 10px;">Error</p>
    <pre style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px 18px;font-size:12px;color:#991b1b;overflow-x:auto;margin:0;white-space:pre-wrap;word-break:break-word;">${esc(error)}</pre>
    <p style="color:${C.muted};font-size:13px;margin:16px 0 0;">To requeue, use <code style="font-size:12px;">POST /v1/queue/retry</code>.</p>
  `;
  return {
    subject: `🔧 Worker job ${jobId.slice(0, 8)} permanently failed after ${attempts} attempts`,
    html: layout(body, { headerBg: C.danger, badge: 'Worker', badgeColor: '#7f1d1d' }),
    text: `Batch job ${jobId} failed after ${attempts} attempts.\nError: ${error}`,
  };
}

export function adminKeyDisabledTemplate({ maskedKey }) {
  const body = `
    ${h1('🔑 API Key Disabled', 'A Gemini API key has been permanently disabled.')}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${kv('Key', `<code style="font-family:monospace;font-size:14px;background:#f8fafc;padding:4px 8px;border-radius:4px;">${esc(maskedKey)}</code>`)}
      ${kv('Status', chip('disabled', C.danger))}
      ${kv('Disabled at', new Date().toUTCString())}
    </table>
    ${box('This key will no longer be used for any requests. To re-enable it, use <code>PATCH /v1/keys/:key/enable</code>.')}
  `;
  return {
    subject: `🔑 API key ${maskedKey} has been disabled`,
    html: layout(body, { badge: 'Key Management', badgeColor: C.muted }),
    text: `API key ${maskedKey} permanently disabled. Re-enable via PATCH /v1/keys/:key/enable.`,
  };
}

export function adminKeyHighRateLimitTemplate({ maskedKey, count429, windowMinutes }) {
  const body = `
    ${h1('🔑 Key Being Rate-Limited', 'A Gemini API key is hitting rate limits frequently.')}
    ${notice(`Key <strong>${esc(maskedKey)}</strong> received <strong>${count429}× rate-limit (429)</strong> responses in the last ${windowMinutes} minutes.`, 'warning')}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${kv('Key', code(maskedKey))}
      ${kv('Rate limits (window)', `${count429}× in ${windowMinutes} min`)}
      ${kv('Detected at', new Date().toUTCString())}
    </table>
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0;">The key has been placed on automatic cooldown. If the issue persists, consider disabling it and adding replacement keys.</p>
  `;
  return {
    subject: `⚠️ Key ${maskedKey} rate-limited ${count429}× in ${windowMinutes}min`,
    html: layout(body, { headerBg: C.warning, badge: 'Key Alert', badgeColor: '#78350f' }),
    text: `Key ${maskedKey} received ${count429} rate-limit responses in ${windowMinutes} minutes.`,
  };
}

export function adminKeyPoolLowTemplate({ activeCount, threshold }) {
  const critical = activeCount === 0;
  const body = `
    ${h1(critical ? '🚨 Key Pool Empty!' : '⚠️ Key Pool Running Low', critical ? 'No active API keys remaining.' : `Only ${activeCount} key${activeCount !== 1 ? 's' : ''} left in the active pool.`)}
    ${notice(
    critical
      ? '<strong>The key pool is empty.</strong> All generation requests will fail immediately.'
      : `Active keys have dropped below the warning threshold of <strong>${threshold}</strong>.`,
    critical ? 'danger' : 'warning'
  )}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${kv('Active keys', `<strong style="font-size:20px;color:${critical ? C.danger : C.warning};">${activeCount}</strong>`)}
      ${kv('Warning threshold', `${threshold}`)}
      ${kv('Detected at', new Date().toUTCString())}
    </table>
    <p style="color:#374151;font-size:14px;margin:0;"><strong>Add more keys immediately:</strong> <code style="font-size:12px;background:#f1f5f9;padding:2px 6px;border-radius:3px;">POST /v1/keys</code></p>
  `;
  return {
    subject: critical ? '🚨 CRITICAL: Key pool empty' : `⚠️ Key pool low: ${activeCount} active key${activeCount !== 1 ? 's' : ''} remaining`,
    html: layout(body, { headerBg: critical ? C.danger : C.warning, badge: 'Key Alert', badgeColor: critical ? '#7f1d1d' : '#78350f' }),
    text: `API key pool ${critical ? 'empty' : 'low'}: ${activeCount} active keys remaining (threshold: ${threshold}).`,
  };
}

export function adminDailySummaryTemplate({ date, totalRequests, successRequests, errorRequests, avgLatencyMs, maxLatencyMs, activeKeys, totalUsers, topModel }) {
  const successRate = totalRequests > 0 ? Math.round((successRequests / totalRequests) * 100) : 100;
  const errorRate = 100 - successRate;
  const rateColor = successRate >= 95 ? C.success : successRate >= 80 ? C.warning : C.danger;

  const body = `
    ${h1(`📊 Daily Report — ${date}`, 'Gemini Proxy performance summary for the past 24 hours.')}

    <!-- 4-stat grid -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border:1px solid ${C.border};border-radius:10px;overflow:hidden;">
      <tr>
        <td width="50%" style="padding:18px 20px;border-right:1px solid ${C.border};border-bottom:1px solid ${C.border};text-align:center;">
          <div style="color:${C.muted};font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;">Total Requests</div>
          <div style="color:${C.dark};font-size:30px;font-weight:800;">${totalRequests.toLocaleString()}</div>
        </td>
        <td width="50%" style="padding:18px 20px;border-bottom:1px solid ${C.border};text-align:center;">
          <div style="color:${C.muted};font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;">Success Rate</div>
          <div style="color:${rateColor};font-size:30px;font-weight:800;">${successRate}%</div>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 20px;border-right:1px solid ${C.border};text-align:center;">
          <div style="color:${C.muted};font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;">Avg Latency</div>
          <div style="color:${C.dark};font-size:30px;font-weight:800;">${avgLatencyMs}<span style="font-size:14px;color:${C.muted};font-weight:400;">ms</span></div>
        </td>
        <td style="padding:18px 20px;text-align:center;">
          <div style="color:${C.muted};font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;">Active Keys</div>
          <div style="color:${C.dark};font-size:30px;font-weight:800;">${activeKeys}</div>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${kv('Successful requests', `${successRequests.toLocaleString()} (${successRate}%)`)}
      ${kv('Failed requests', `${errorRequests.toLocaleString()} (${errorRate}%)`)}
      ${kv('Max latency', `${maxLatencyMs.toLocaleString()}ms`)}
      ${kv('Top model', topModel ? chip(topModel, C.brand) : '<span style="color:#94a3b8;">No data</span>')}
      ${kv('Total users', totalUsers.toLocaleString())}
    </table>

    ${errorRate > 20
      ? notice(`Elevated error rate of <strong>${errorRate}%</strong> detected. Review the error log for details.`, 'warning')
      : notice('System performance is within normal parameters.', 'success')
    }
  `;
  return {
    subject: `📊 Daily Report — ${date} | ${totalRequests.toLocaleString()} req, ${successRate}% success`,
    html: layout(body, { badge: 'Daily Report', badgeColor: C.brand }),
    text: `Daily Report — ${date}\nTotal: ${totalRequests} | Success: ${successRate}% | Avg: ${avgLatencyMs}ms | Keys: ${activeKeys}\nTop model: ${topModel ?? 'N/A'}`,
  };
}
