import { getDb } from './client.js';

const COLLECTION = 'api_keys';

/**
 * Persist an API key with its state.
 */
export async function upsertApiKey(key, { status = 'active', cooldownUntil = null, reason = null } = {}) {
  const db = await getDb();
  const update = { 
    status, 
    cooldown_until: cooldownUntil, 
    updated_at: new Date() 
  };
  if (reason) update.last_reason = reason;
  await db.collection(COLLECTION).updateOne(
    { key },
    { $set: update },
    { upsert: true }
  );
}

/**
 * Remove an API key from the database.
 */
export async function removeApiKey(key) {
  const db = await getDb();
  await db.collection(COLLECTION).deleteOne({ key });
}

/**
 * Retrieve all API keys from the database.
 */
export async function getAllApiKeys() {
  const db = await getDb();
  return db.collection(COLLECTION).find({}).toArray();
}
