import { Worker, UnrecoverableError } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config.js';
import { runGenerate } from '../services/orchestrator.js';
import { QUEUE_NAME } from './index.js';
import { notifyAdminWorkerFailure } from '../services/notifications.js';

function makeRedisConnection() {
  return new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
  });
}

export function startWorker(concurrency = 5) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { prompt, model, options, requestId, userEmail } = job.data;

      const result = await runGenerate({ prompt, model, options, requestId, userEmail });

      if (result.error) {
        // Hard errors (bad request, auth) must not be retried
        if (result.httpStatus === 400 || result.httpStatus === 401 || result.httpStatus === 403) {
          throw new UnrecoverableError(result.error);
        }
        // Soft errors — BullMQ will retry with exponential backoff
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

  worker.on('completed', (job) => {
    console.info(`[worker] job ${job.id} completed (model: ${job.returnvalue?.model})`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} failed: ${err.message}`);
    // Notify admin only when a job is permanently dead (all retries exhausted or unrecoverable)
    if (job && (err instanceof UnrecoverableError || job.attemptsMade >= (job.opts?.attempts ?? 1))) {
      notifyAdminWorkerFailure({
        jobId:    String(job.id),
        error:    err.message,
        attempts: job.attemptsMade,
      });
    }
  });

  return worker;
}
