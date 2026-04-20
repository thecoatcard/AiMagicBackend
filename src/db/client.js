import { MongoClient } from 'mongodb';
import { config } from '../config.js';

// Promise-based singleton — safe for concurrent startup calls
let _connectingPromise = null;
let _db = null;
let _client = null;

export async function getDb() {
  if (_db) return _db;

  // If already connecting, wait for the same promise rather than opening a second connection
  if (!_connectingPromise) {
    _connectingPromise = (async () => {
      const client = new MongoClient(config.mongodbUri, {
        maxPoolSize: 100,
        serverSelectionTimeoutMS: 5000,
      });

      await client.connect();
      const db = client.db(config.mongodbName);

      await db.collection('requests').createIndexes([
        { key: { created_at: -1 } },
        { key: { api_key_masked: 1, created_at: -1 } },
        { key: { model: 1, created_at: -1 } },
        { key: { status: 1 } },
        { key: { user_email: 1, created_at: -1 } },
      ]);

      await db.collection('errors').createIndexes([
        { key: { timestamp: -1 } },
        { key: { type: 1 } },
        { key: { model: 1 } },
      ]);

      console.info('[MongoDB] connected to', config.mongodbName);
      _client = client;
      _db = db;
      return db;
    })().catch((err) => {
      _connectingPromise = null; // allow retry on next call
      throw err;
    });
  }

  return _connectingPromise;
}

/**
 * Close the MongoDB connection gracefully.
 */
export async function closeDb() {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
    _connectingPromise = null;
  }
}
