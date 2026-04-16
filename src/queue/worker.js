import { Worker, UnrecoverableError } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config.js';
import { runGenerate } from '../services/orchestrator.js';
import { QUEUE_NAME } from './index.js';
import { notifyAdminWorkerFailure } from '../services/notifications.js';
import { queueWaitDuration } from '../metrics/index.js';

function makeRedisConnection() {
  return new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
  });
}

let _worker;

export function startWorker(concurrency = 5) {
  if (_worker) return _worker;

  _worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      // Record how long this job spent waiting in the queue
      const waitTime = Date.now() - job.timestamp;
      queueWaitDuration.observe(waitTime);

      const { prompt, model, options, requestId, userEmail } = job.data;
      const result = await runGenerate({ prompt, model, options, requestId, userEmail });

      if (result.error) {
        if (result.httpStatus === 400 || result.httpStatus === 401 || result.httpStatus === 403) {
          throw new UnrecoverableError(result.error);
        }
        throw new Error(result.error);
      }
      return result;
    },
    {
      connection: makeRedisConnection(),
      concurrency,
      limiter: {
        max: concurrency,
        duration: 1000,
      },
    }
  );

  _worker.on('completed', (job) => {
    console.info(`[worker] job ${job.id} completed (model: ${job.returnvalue?.model})`);
  });

  _worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} failed: ${err.message}`);
    if (job && (err instanceof UnrecoverableError || job.attemptsMade >= (job.opts?.attempts ?? 1))) {
      notifyAdminWorkerFailure({
        jobId:    String(job.id),
        error:    err.message,
        attempts: job.attemptsMade,
      });
    }
  });

  return _worker;
}

/**
 * Perform a graceful shutdown of the worker.
 * Returns a promise that resolves when active jobs are finished and connections closed.
 */
export async function stopWorker() {
  if (_worker) {
    console.info('[worker] shutting down gracefully...');
    await _worker.close();
    _worker = null;
    console.info('[worker] shut down complete');
  }
}
