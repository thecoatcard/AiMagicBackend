import Redis from 'ioredis';
import { config } from '../config.js';

let _client;

export function getRedis() {
  if (!_client) {
    _client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      // Exponential back-off capped at 10s; retries indefinitely so the app
      // recovers automatically when Redis restarts (e.g. on Termux/Android).
      retryStrategy(times) {
        return Math.min(times * 200, 10_000);
      },
      // Reconnect on ECONNABORTED / ECONNRESET / EPIPE (network interruptions)
      reconnectOnError(err) {
        return err.code === 'ECONNABORTED'
          || err.code === 'ECONNRESET'
          || err.code === 'EPIPE';
      },
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
