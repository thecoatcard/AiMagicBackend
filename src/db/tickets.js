import { ObjectId } from 'mongodb';
import { getDb } from './client.js';

/**
 * Create compound indexes for fast ticket lookups.
 */
export async function ensureTicketIndexes() {
  const db = await getDb();
  const col = db.collection('tickets');
  await Promise.all([
    col.createIndex({ user_email: 1 }),
    col.createIndex({ status: 1 }),
    col.createIndex({ created_at: -1 }),
  ]);
}

/**
 * Create a text index on subject + description for full-text search.
 * Call once on startup alongside ensureTicketIndexes.
 */
export async function ensureTicketTextIndex() {
  const db = await getDb();
  await db.collection('tickets').createIndex(
    { subject: 'text', description: 'text' },
    { name: 'ticket_text_search' }
  );
}

/**
 * Insert a new ticket. Returns the serialized ticket document.
 */
export async function createTicket({ userEmail, subject, description, priority = 'medium', screenshotPath = null }) {
  const db = await getDb();
  const now = new Date();
  const result = await db.collection('tickets').insertOne({
    user_email: userEmail,
    subject,
    description,
    priority,
    status: 'open',
    screenshot_path: screenshotPath,
    admin_response: null,
    created_at: now,
    updated_at: now,
  });
  return getTicketById(result.insertedId.toString());
}

/**
 * Fetch a single ticket by its ObjectId string.
 * Returns null if not found or id is malformed.
 */
export async function getTicketById(id) {
  const db = await getDb();
  try {
    const doc = await db.collection('tickets').findOne({ _id: new ObjectId(id) });
    return serialize(doc);
  } catch {
    return null; // invalid ObjectId format
  }
}

/**
 * List tickets with optional filters, text search, date range, and pagination.
 *
 * @param {{ userEmail?, status?, priority?, search?, from?, to?, limit?, skip? }} opts
 */
export async function listTickets({ userEmail, status, priority, search, from, to, limit = 50, skip = 0 } = {}) {
  const db = await getDb();
  const filter = {};
  if (userEmail) filter.user_email = userEmail;
  if (status)    filter.status     = status;
  if (priority)  filter.priority   = priority;
  if (search)    filter.$text      = { $search: search };
  if (from || to) {
    filter.created_at = {};
    if (from) filter.created_at.$gte = new Date(from);
    if (to)   filter.created_at.$lte = new Date(to);
  }

  const col = db.collection('tickets');
  const [docs, total] = await Promise.all([
    col.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
    col.countDocuments(filter),
  ]);
  return { tickets: docs.map(serialize), total };
}

/**
 * Update a ticket (admin action).
 * Returns the updated serialized ticket, or null if not found.
 */
export async function updateTicket(id, { status, admin_response, priority, admin_notes } = {}) {
  const db = await getDb();
  const set = { updated_at: new Date() };
  if (status         !== undefined) set.status         = status;
  if (admin_response !== undefined) set.admin_response = admin_response;
  if (priority       !== undefined) set.priority       = priority;
  if (admin_notes    !== undefined) set.admin_notes    = admin_notes;

  try {
    const doc = await db.collection('tickets').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: set },
      { returnDocument: 'after' }
    );
    return serialize(doc);
  } catch {
    return null;
  }
}

/**
 * Delete a ticket by id. Returns true if deleted.
 */
export async function deleteTicket(id) {
  const db = await getDb();
  try {
    const result = await db.collection('tickets').deleteOne({ _id: new ObjectId(id) });
    return result.deletedCount > 0;
  } catch {
    return false;
  }
}

/**
 * Aggregate ticket statistics broken down by status and priority.
 */
export async function getTicketStats() {
  const db = await getDb();
  const col = db.collection('tickets');
  const [total, byStatus, byPriority] = await Promise.all([
    col.countDocuments(),
    col.aggregate([{ $group: { _id: '$status',   count: { $sum: 1 } } }]).toArray(),
    col.aggregate([{ $group: { _id: '$priority', count: { $sum: 1 } } }]).toArray(),
  ]);
  return {
    total,
    by_status:   Object.fromEntries(byStatus.map(r   => [r._id, r.count])),
    by_priority: Object.fromEntries(byPriority.map(r => [r._id, r.count])),
  };
}

/**
 * Bulk close (or resolve) a list of tickets by id.
 * @param {string[]} ids    - array of ticket ObjectId strings
 * @param {string}   status - 'resolved' | 'closed'
 * @returns {{ matched: number, modified: number }}
 */
export async function bulkCloseTickets(ids, status) {
  const db = await getDb();
  const objectIds = ids
    .map(id => { try { return new ObjectId(id); } catch { return null; } })
    .filter(Boolean);

  const result = await db.collection('tickets').updateMany(
    { _id: { $in: objectIds } },
    { $set: { status, updated_at: new Date() } }
  );
  return { matched: result.matchedCount, modified: result.modifiedCount };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function serialize(doc) {
  if (!doc) return null;
  return {
    id:             doc._id.toString(),
    user_email:     doc.user_email,
    subject:        doc.subject,
    description:    doc.description,
    priority:       doc.priority,
    status:         doc.status,
    screenshot_path: doc.screenshot_path ?? null,
    admin_response: doc.admin_response,
    admin_notes:    doc.admin_notes ?? null,
    created_at:     doc.created_at,
    updated_at:     doc.updated_at,
  };
}
