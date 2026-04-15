import { GridFSBucket } from 'mongodb';
import { getDb } from './client.js';

let _bucket = null;

/**
 * Get or initialize the GridFS bucket for tools.
 */
export async function getToolsBucket() {
  if (_bucket) return _bucket;
  
  const db = await getDb();
  _bucket = new GridFSBucket(db, {
    bucketName: 'tools_files',
  });
  
  return _bucket;
}
