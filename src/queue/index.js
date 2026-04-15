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
      defaultJobOptions: {
        attempts: config.maxRetries,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return _queue;
}
