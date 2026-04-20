import { getQueue } from '../queue/index.js';
import { getBatch } from '../db/batches.js';

const BATCH_CHUNK_SIZE = 50;

export async function queueRoutes(fastify) {
  // GET /v1/queue/status — queue health and counts
  fastify.get('/v1/queue/status', async () => {
    const queue = getQueue();
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
    return {
      queue: queue.name,
      counts,
    };
  });

  // GET /v1/queue/batch/:batchId — status of all jobs in a batch
  fastify.get('/v1/queue/batch/:batchId', async (request, reply) => {
    const { batchId } = request.params;
    const queue = getQueue();

    let batch;
    try {
      // Validate ownership / exists in MongoDB
      batch = await getBatch(batchId, request.user?.email, request.user?.role === 'owner');
    } catch (err) {
      if (err.code === 'FORBIDDEN') {
        reply.status(403);
        return { error: 'Forbidden', code: 'FORBIDDEN' };
      }
      throw err;
    }

    if (!batch) {
      reply.status(404);
      return { error: 'Batch not found', batch_id: batchId };
    }

    // Process jobs in chunks to avoid massive concurrent Redis calls
    const jobs = [];
    for (let i = 0; i < batch.job_ids.length; i += BATCH_CHUNK_SIZE) {
      const chunk = batch.job_ids.slice(i, i + BATCH_CHUNK_SIZE);
      const chunkResults = await Promise.all(
        chunk.map(async (jobId, ci) => {
          const idx = i + ci;
          const job = await queue.getJob(jobId);
          if (!job) {
            return { job_id: jobId, prompt_index: idx, state: 'deleted', error: 'Job result expired' };
          }
          const state = await job.getState();
          return {
            job_id: jobId,
            prompt_index: job.data?.prompt_index ?? idx,
            state,
            result: state === 'completed' ? job.returnvalue : undefined,
            error:  state === 'failed' ? job.failedReason : undefined,
          };
        })
      );
      jobs.push(...chunkResults);
    }

    const done = jobs.filter(j => j.state === 'completed').length;
    const failed = jobs.filter(j => j.state === 'failed').length;

    return {
      batch_id: batchId,
      total: batch.total,
      completed: done,
      failed,
      pending: Math.max(0, batch.total - done - failed),
      jobs,
    };
  });

  // POST /v1/queue/retry — retry failed jobs in paginated batches
  fastify.post('/v1/queue/retry', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
        },
      },
    },
  }, async (request) => {
    const queue = getQueue();
    const limit = request.query.limit ?? 200;
    const failedJobs = await queue.getFailed(0, limit - 1);
    for (let i = 0; i < failedJobs.length; i += BATCH_CHUNK_SIZE) {
      await Promise.all(failedJobs.slice(i, i + BATCH_CHUNK_SIZE).map(job => job.retry()));
    }
    return { retried: failedJobs.length };
  });

  // POST /v1/queue/pause — pause the queue (stops workers picking up new jobs)
  fastify.post('/v1/queue/pause', async () => {
    await getQueue().pause();
    return { paused: true };
  });

  // POST /v1/queue/resume — resume the queue
  fastify.post('/v1/queue/resume', async () => {
    await getQueue().resume();
    return { paused: false };
  });

  // DELETE /v1/queue/failed — drain (remove) failed jobs in paginated batches
  fastify.delete('/v1/queue/failed', async () => {
    const queue = getQueue();
    let total = 0;
    let batch;
    do {
      batch = await queue.getFailed(0, BATCH_CHUNK_SIZE - 1);
      if (batch.length > 0) {
        await Promise.all(batch.map(job => job.remove()));
        total += batch.length;
      }
    } while (batch.length === BATCH_CHUNK_SIZE);
    return { drained: total };
  });

  // DELETE /v1/queue/completed — drain (remove) completed jobs in paginated batches
  fastify.delete('/v1/queue/completed', async () => {
    const queue = getQueue();
    let total = 0;
    let batch;
    do {
      batch = await queue.getCompleted(0, BATCH_CHUNK_SIZE - 1);
      if (batch.length > 0) {
        await Promise.all(batch.map(job => job.remove()));
        total += batch.length;
      }
    } while (batch.length === BATCH_CHUNK_SIZE);
    return { drained: total };
  });

  // POST /v1/queue/jobs/:jobId/retry — retry a single job by id
  fastify.post('/v1/queue/jobs/:jobId/retry', async (request, reply) => {
    const queue = getQueue();
    const job = await queue.getJob(request.params.jobId);
    if (!job) {
      reply.status(404);
      return { error: 'Job not found', jobId: request.params.jobId };
    }
    await job.retry();
    return { retried: true, jobId: job.id };
  });
}
