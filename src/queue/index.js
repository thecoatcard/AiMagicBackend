import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config.js';

export const QUEUE_NAME = 'gemini-batch';

// BullMQ requires an ioredis instance, NOT a plain { url } object
function makeRedisConnection() {
  return new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
  });
}

let _queue;

export function getQueue() {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, {
      connection: makeRedisConnection(),
      settings: {
        backoffStrategies: {
          jitter: (attemptsMade) => {
            const delay = Math.pow(2, attemptsMade - 1) * 1000;
            const jitter = Math.floor(Math.random() * 1000);
            return delay + jitter;
          }
        }
      },
      defaultJobOptions: {
        attempts: config.maxRetries,
        backoff: { type: 'jitter' },
        removeOnComplete: { 
          age: 1800, // keep for 30 minutes
          count: 1000 
        },
        removeOnFail: { 
          age: 86400, // keep for 24 hours
          count: 500 
        },
      },
    });
  }
  return _queue;
}
