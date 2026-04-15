import { getDb } from './client.js';
import { ObjectId } from 'mongodb';

export async function ensureToolsIndexes() {
  const db = await getDb();
  const col = db.collection('tools');
  await Promise.all([
    col.createIndex({ name: 1 }, { unique: true }),
    col.createIndex({ is_active: 1 }),
    col.createIndex({ tags: 1 }),
    col.createIndex({ created_at: -1 }),
  ]);
}

function serialize(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { 
    id: _id.toString(), 
    ...rest,
    file_id: doc.file_id ? doc.file_id.toString() : null 
  };
}

/**
 * Create a new tool.
 * @param {object} data
 * @param {string} data.name
 * @param {string} data.description
 * @param {string|null} data.icon         — base64 data URL or external image URL
 * @param {'zip'|'external'} data.type
 * @param {string|null} [data.file_id]    — GridFS file ID (zip type)
 * @param {string|null} [data.file_name]  — original filename (zip type)
 * @param {number|null} [data.file_size]  — bytes (zip type)
 * @param {string|null} [data.external_url] — download URL (external type)
 * @param {string|null} [data.version]
 * @param {string[]}    [data.tags]
 * @param {string}      data.created_by
 */
export async function createTool(data) {
  const db = await getDb();
  const doc = {
    name:         data.name,
    description:  data.description,
    icon:         data.icon ?? null,
    type:         data.type,
    file_id:      data.file_id      ? new ObjectId(data.file_id) : null,
    file_name:    data.file_name    ?? null,
    file_size:    data.file_size    ?? null,
    external_url: data.external_url ?? null,
    version:      data.version      ?? null,
    tags:         data.tags         ?? [],
    download_count: 0,
    is_active:    true,
    created_by:   data.created_by,
    created_at:   new Date(),
    updated_at:   new Date(),
  };
  const result = await db.collection('tools').insertOne(doc);
  return serialize({ ...doc, _id: result.insertedId });
}

export async function getTool(id) {
  try {
    const db = await getDb();
    const doc = await db.collection('tools').findOne({ _id: new ObjectId(id) });
    return serialize(doc);
  } catch {
    return null;
  }
}

export async function listTools({ activeOnly = false, limit = 50, skip = 0, tag } = {}) {
  const db = await getDb();
  const filter = {};
  if (activeOnly) filter.is_active = true;
  if (tag) filter.tags = tag;

  const [items, total] = await Promise.all([
    db.collection('tools')
      .find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    db.collection('tools').countDocuments(filter),
  ]);
  return { total, items: items.map(serialize) };
}

/**
 * Update mutable fields of a tool.
 */
export async function updateTool(id, updates) {
  try {
    const db = await getDb();
    const $set = { updated_at: new Date() };
    const allowed = ['name', 'description', 'icon', 'external_url', 'file_id', 'file_name', 'file_size', 'version', 'tags'];
    for (const key of allowed) {
      if (key in updates) {
        if (key === 'file_id' && updates[key]) {
          $set[key] = new ObjectId(updates[key]);
        } else {
          $set[key] = updates[key];
        }
      }
    }
    const result = await db.collection('tools').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: 'after' },
    );
    return serialize(result);
  } catch {
    return null;
  }
}

export async function toggleToolActive(id) {
  try {
    const db = await getDb();
    const tool = await db.collection('tools').findOne({ _id: new ObjectId(id) });
    if (!tool) return null;
    const result = await db.collection('tools').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { is_active: !tool.is_active, updated_at: new Date() } },
      { returnDocument: 'after' },
    );
    return serialize(result);
  } catch {
    return null;
  }
}

export async function deleteTool(id) {
  try {
    const db = await getDb();
    const doc = await db.collection('tools').findOne({ _id: new ObjectId(id) });
    
    if (doc?.file_id) {
      const { getToolsBucket } = await import('./gridfs.js');
      const bucket = await getToolsBucket();
      try { await bucket.delete(doc.file_id); } catch {}
    }

    const result = await db.collection('tools').deleteOne({ _id: new ObjectId(id) });
    return result.deletedCount > 0;
  } catch {
    return false;
  }
}

/**
 * Atomically increment download_count and return new count.
 */
export async function incrementDownloadCount(id) {
  try {
    const db = await getDb();
    const result = await db.collection('tools').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $inc: { download_count: 1 } },
      { returnDocument: 'after', projection: { download_count: 1 } },
    );
    return result?.download_count ?? null;
  } catch {
    return null;
  }
}
