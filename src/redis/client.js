import Redis from 'ioredis';
import { config } from '../config.js';

let _client;

export function getRedis() {
  if (!_client) {
    _client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    _client.on('error', (err) => {
      console.error('[Redis] connection error:', err.message);
    });

    _client.on('connect', () => {
      console.info('[Redis] connected');
    });
  }
  return _client;
}
