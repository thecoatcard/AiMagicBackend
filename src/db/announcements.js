import { getDb } from './client.js';

/**
 * Create a new announcement.
 */
export async function createAnnouncement({ title, content, target_audience, created_by }) {
  const db = await getDb();
  const announcement = {
    title,
    content,
    target_audience, // 'all' or 'premium'
    created_by,
    created_at: new Date(),
  };
  const result = await db.collection('announcements').insertOne(announcement);
  return { ...announcement, _id: result.insertedId };
}

/**
 * List announcements for a specific user based on their plan.
 */
export async function listAnnouncementsForUser(plan) {
  const db = await getDb();
  const filter = {
    target_audience: { $in: ['all', plan === 'premium' ? 'premium' : 'all'] }
  };
  return db.collection('announcements')
    .find(filter)
    .sort({ created_at: -1 })
    .toArray();
}

/**
 * List all announcements (for admin/owner).
 */
export async function listAllAnnouncements() {
  const db = await getDb();
  return db.collection('announcements')
    .find({})
    .sort({ created_at: -1 })
    .toArray();
}

/**
 * Delete an announcement.
 */
export async function deleteAnnouncement(id) {
  const db = await getDb();
  const { ObjectId } = await import('mongodb');
  const result = await db.collection('announcements').deleteOne({ _id: new ObjectId(id) });
  return result.deletedCount > 0;
}
