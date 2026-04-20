import { getDb } from './client.js';

const DEFAULT_LIMITS = {
  max_requests_per_min: 60,
  // max_requests_per_day is intentionally omitted — it is now derived from user.plan.
  // Set it explicitly via PATCH /v1/users/:email/limits for per-user overrides.
};

/**
 * Upsert a user document on login.
 * Creates with role:'user', status:'active', default limits if not already present.
 * Always updates last_login.
 * Returns the user document (or null if DB is unavailable).
 */
export async function getOrCreateUser(email) {
  let db;
  try {
    db = await getDb();
  } catch {
    return null;
  }
  const col = db.collection('users');
  await col.updateOne(
    { email },
    {
      $set: { last_login: new Date() },
      $setOnInsert: {
        role:      'user',
        plan:      'free',
        status:    'active',
        limits:    { ...DEFAULT_LIMITS },
        usage:     { total_requests: 0 },
        created_at: new Date(),
      },
    },
    { upsert: true }
  );
  return col.findOne({ email }, { projection: { _id: 0 } });
}

/**
 * Fetch a single user by email. Returns null if not found or DB unavailable.
 */
export async function getUser(email) {
  let db;
  try {
    db = await getDb();
  } catch {
    return null;
  }
  return db.collection('users').findOne({ email }, { projection: { _id: 0 } });
}

/**
 * List all users with optional pagination.
 */
export async function listUsers({ limit = 50, skip = 0 } = {}) {
  const db = await getDb();
  const col = db.collection('users');
  const [users, total] = await Promise.all([
    col.find({}, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    col.countDocuments({}),
  ]);
  return { users, total };
}

/**
 * Update a user's role. Returns false if user not found.
 */
export async function setUserRole(email, role) {
  const db = await getDb();
  const result = await db.collection('users').updateOne({ email }, { $set: { role } });
  return result.matchedCount > 0;
}

/**
 * Update a user's status (active/blocked). Returns false if user not found.
 */
export async function setUserStatus(email, status) {
  const db = await getDb();
  const result = await db.collection('users').updateOne({ email }, { $set: { status } });
  return result.matchedCount > 0;
}

/**
 * Update per-user rate limits. Returns false if user not found.
 */
export async function setUserLimits(email, limits) {
  const db = await getDb();
  const set = {};
  if (limits.max_requests_per_min !== undefined) {
    set['limits.max_requests_per_min'] = limits.max_requests_per_min;
  }
  if (limits.max_requests_per_day !== undefined) {
    set['limits.max_requests_per_day'] = limits.max_requests_per_day;
  }
  if (Object.keys(set).length === 0) return false;
  const result = await db.collection('users').updateOne({ email }, { $set: set });
  return result.matchedCount > 0;
}

/**
 * Update a user's plan (free / premium).
 * Also clears any custom max_requests_per_day override so the plan limit
 * takes effect immediately without needing a manual limits update.
 * Returns false if user not found.
 */
export async function setUserPlan(email, plan, expiresAt = null) {
  const db = await getDb();
  const update = {
    $set:   { plan },
    $unset: { 'limits.max_requests_per_day': '' },
  };

  if (plan === 'premium' && expiresAt) {
    update.$set.premium_expires_at = expiresAt;
  } else {
    update.$unset.premium_expires_at = '';
  }

  const result = await db.collection('users').updateOne({ email }, update);
  return result.matchedCount > 0;
}

/**
 * Find all users whose premium plan has expired and revert them to 'free'.
 * This is meant to be called by a periodic background worker.
 */
export async function revertExpiredPremiums() {
  const db = await getDb();
  const now = new Date();

  // 1. Find the target users
  const expiredUsers = await db.collection('users').find({
    plan:               'premium',
    premium_expires_at: { $lte: now },
  }).toArray();

  if (expiredUsers.length === 0) return { reverted: 0 };

  const emails = expiredUsers.map(u => u.email);

  // 2. Perform bulk update
  const result = await db.collection('users').updateMany(
    { email: { $in: emails } },
    {
      $set:   { plan: 'free' },
      $unset: { premium_expires_at: '', 'limits.max_requests_per_day': '' },
    }
  );

  return { 
    reverted: result.modifiedCount, 
    emails 
  };
}


/**
 * Atomically increment total_requests usage counter.
 * Fire-and-forget — caller should not await.
 */
export function incrementUserUsage(email, count = 1) {
  getDb()
    .then(db =>
      db.collection('users').updateOne(
        { email },
        { $inc: { 'usage.total_requests': count } }
      )
    )
    .catch(() => {}); // never block the request path
}

/**
 * Delete a user document. Returns false if user not found.
 */
export async function deleteUser(email) {
  const db = await getDb();
  const result = await db.collection('users').deleteOne({ email });
  return result.deletedCount > 0;
}

/**
 * Upsert the owner account.
 * - Always forces role:'owner' and status:'active' on the document.
 * - Creates the document with default limits/usage if it doesn't exist yet.
 * - Called on every startup so the owner role is self-healing if ever
 *   accidentally changed directly in the DB.
 */
export async function ensureOwner(email) {
  if (!email) return;
  const db = await getDb();
  await db.collection('users').updateOne(
    { email },
    {
      $set: { role: 'owner', status: 'active' },
      $setOnInsert: {
        created_at: new Date(),
        limits: { ...DEFAULT_LIMITS },
        usage: { total_requests: 0 },
      },
    },
    { upsert: true }
  );
}

/**
 * List users with filtering, text search, and sorting.
 * @param {{ role?, plan?, status?, email?, limit?, skip?, sort? }} opts
 */
export async function listUsersFiltered({ role, plan, status, email, limit = 50, skip = 0, sort = 'created' } = {}) {
  const db = await getDb();
  const filter = {};
  if (role)   filter.role   = role;
  if (plan)   filter.plan   = plan;
  if (status) filter.status = status;
  if (email)  filter.email  = { $regex: email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

  const sortMap = {
    email:   { email: 1 },
    usage:   { 'usage.total_requests': -1 },
    created: { created_at: -1 },
  };
  const sortObj = sortMap[sort] ?? { created_at: -1 };

  const col = db.collection('users');
  const [users, total] = await Promise.all([
    col.find(filter, { projection: { _id: 0 } })
      .sort(sortObj).skip(skip).limit(limit).toArray(),
    col.countDocuments(filter),
  ]);
  return { users, total };
}

/**
 * Aggregate user statistics broken down by role, plan, and status.
 */
export async function getUserStats() {
  const db = await getDb();
  const col = db.collection('users');
  const [total, byRole, byPlan, byStatus] = await Promise.all([
    col.countDocuments(),
    col.aggregate([{ $group: { _id: '$role',   count: { $sum: 1 } } }]).toArray(),
    col.aggregate([{ $group: { _id: '$plan',   count: { $sum: 1 } } }]).toArray(),
    col.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
  ]);
  return {
    total,
    by_role:   Object.fromEntries(byRole.map(r   => [r._id, r.count])),
    by_plan:   Object.fromEntries(byPlan.map(r   => [r._id, r.count])),
    by_status: Object.fromEntries(byStatus.map(r => [r._id, r.count])),
  };
}

/**
 * Bulk update a set of users.
 * @param {string[]} emails
 * @param {object}  update  - fields to $set (e.g. { status: 'blocked' })
 * @returns {{ matched: number, modified: number }}
 */
export async function bulkUpdateUsers(emails, update) {
  const db = await getDb();
  const result = await db.collection('users').updateMany(
    { email: { $in: emails } },
    { $set: update }
  );
  return { matched: result.matchedCount, modified: result.modifiedCount };
}

/**
 * Ensure indexes exist on the users collection.
 * Includes a case-insensitive unique index on email.
 */
export async function ensureUserIndexes() {
  const db = await getDb();
  const col = db.collection('users');
  
  // Standard unique index
  await col.createIndex({ email: 1 }, { unique: true });

  // Case-insensitive index for fast Admin searches
  // Collation strength 2 = ignore case
  await col.createIndex(
    { email: 1 },
    { 
      name: 'email_case_insensitive',
      collation: { locale: 'en', strength: 2 } 
    }
  );
}
