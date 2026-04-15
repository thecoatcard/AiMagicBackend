import { getDb } from './client.js';

/**
 * Ensure indexes for the audit_log collection.
 */
export async function ensureAuditLogIndexes() {
  const db = await getDb();
  const col = db.collection('audit_log');
  await Promise.all([
    col.createIndex({ actor_email: 1 }),
    col.createIndex({ action: 1 }),
    col.createIndex({ target_email: 1 }),
    col.createIndex({ created_at: -1 }),
  ]);
}

/**
 * Write an audit log entry. Fire-and-forget — never throws, never blocks.
 *
 * @param {{ actorEmail: string, action: string, targetEmail?: string, meta?: object }} opts
 */
export function writeAuditLog({ actorEmail, action, targetEmail = null, meta = {} }) {
  getDb()
    .then(db =>
      db.collection('audit_log').insertOne({
        actor_email:  actorEmail,
        action,
        target_email: targetEmail,
        meta,
        created_at:   new Date(),
      })
    )
    .catch(() => {}); // never block the request path
}

/**
 * List audit log entries with optional filters and pagination.
 *
 * @param {{ actorEmail?, action?, targetEmail?, from?, to?, limit?, skip? }} opts
 */
export async function listAuditLog({
  actorEmail,
  action,
  targetEmail,
  from,
  to,
  limit = 100,
  skip = 0,
} = {}) {
  const db = await getDb();
  const filter = {};
  if (actorEmail)  filter.actor_email  = actorEmail;
  if (action)      filter.action       = action;
  if (targetEmail) filter.target_email = targetEmail;
  if (from || to) {
    filter.created_at = {};
    if (from) filter.created_at.$gte = new Date(from);
    if (to)   filter.created_at.$lte = new Date(to);
  }

  const col = db.collection('audit_log');
  const [logs, total] = await Promise.all([
    col.find(filter, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    col.countDocuments(filter),
  ]);
  return { logs, total };
}
