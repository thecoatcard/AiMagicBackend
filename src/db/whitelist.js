import { getDb } from './client.js';

/**
 * Ensure indexes for the whitelist collection.
 */
export async function ensureWhitelistIndexes() {
  const db = await getDb();
  await db.collection('whitelist').createIndex(
    { type: 1, value: 1 },
    { unique: true }
  );
}

/**
 * Check if an email is allowed to register/login.
 *
 * Rules:
 *  - If the whitelist is empty → open registration, everyone allowed.
 *  - Otherwise: the email itself OR its domain must be in the whitelist.
 *
 * Fails open if the DB is unavailable (returns true) so a DB outage
 * never locks everyone out.
 *
 * @param {string} email
 * @returns {Promise<boolean>}
 */
export async function isEmailAllowed(email) {
  let db;
  try {
    db = await getDb();
  } catch {
    return true; // fail open — DB unavailable
  }

  const col = db.collection('whitelist');
  const count = await col.countDocuments();
  if (count === 0) return true; // whitelist is empty = open registration

  const domain = email.split('@')[1] ?? '';
  const match = await col.findOne({
    $or: [
      { type: 'email',  value: email  },
      { type: 'domain', value: domain },
    ],
  });

  return !!match;
}

/**
 * List all whitelist rules, newest first.
 */
export async function listWhitelist() {
  const db = await getDb();
  return db.collection('whitelist')
    .find({}, { projection: { _id: 0 } })
    .sort({ created_at: -1 })
    .toArray();
}

/**
 * Add a whitelist rule.
 * @param {'email'|'domain'} type
 * @param {string} value
 * @param {string} [note]
 * @returns {{ added: boolean, reason?: string }}
 */
export async function addWhitelistRule(type, value, note = '') {
  const db = await getDb();
  try {
    await db.collection('whitelist').insertOne({
      type,
      value,
      note,
      created_at: new Date(),
    });
    return { added: true };
  } catch (err) {
    if (err.code === 11000) return { added: false, reason: 'already_exists' };
    throw err;
  }
}

/**
 * Remove a whitelist rule by type + value.
 * @returns {boolean} true if removed, false if not found
 */
export async function removeWhitelistRule(type, value) {
  const db = await getDb();
  const result = await db.collection('whitelist').deleteOne({ type, value });
  return result.deletedCount > 0;
}
