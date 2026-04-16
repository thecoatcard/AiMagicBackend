import { getDb } from './client.js';

const COLLECTION = 'batches';

/**
 * Persist a batch and its associated job IDs.
 */
export async function createBatch(batchId, { jobIds, userEmail, total }) {
  const db = await getDb();
  await db.collection(COLLECTION).insertOne({
    batch_id: batchId,
    job_ids: jobIds,
    user_email: userEmail,
    total,
    created_at: new Date(),
  });
}

/**
 * Retrieve a batch and verify ownership.
 */
export async function getBatch(batchId, userEmail, isAdmin = false) {
  const db = await getDb();
  const filter = { batch_id: batchId };
  
  // Security: only allow owner or admin to view
  const batch = await db.collection(COLLECTION).findOne(filter);
  if (!batch) return null;

  if (!isAdmin && batch.user_email !== userEmail) {
    const err = new Error('Forbidden');
    err.code = 'FORBIDDEN';
    throw err;
  }

  return batch;
}
