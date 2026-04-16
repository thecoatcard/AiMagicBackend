import { getDb } from './client.js';

const COLLECTION = 'config';

/**
 * Save a specific configuration document (e.g., 'system' or 'models').
 */
export async function savePersistentConfig(id, data) {
  const db = await getDb();
  await db.collection(COLLECTION).updateOne(
    { _id: id },
    { $set: { ...data, updated_at: new Date() } },
    { upsert: true }
  );
}

/**
 * Retrieve a persistent configuration document by ID.
 */
export async function getPersistentConfig(id) {
  const db = await getDb();
  return db.collection(COLLECTION).findOne({ _id: id });
}
