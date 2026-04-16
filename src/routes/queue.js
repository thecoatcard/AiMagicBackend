import { getQueue } from '../queue/index.js';
import { getBatch } from '../db/batches.js';

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

    // Optimization: only fetch the specific jobs listed in the batch
    const jobs = await Promise.all(
      batch.job_ids.map(async (jobId, i) => {
        const job = await queue.getJob(jobId);
        if (!job) {
          return { job_id: jobId, prompt_index: i, state: 'deleted', error: 'Job result expired' };
        }
        const state = await job.getState();
        return {
          job_id: jobId,
          prompt_index: job.data?.prompt_index ?? i,
          state,
          result: state === 'completed' ? job.returnvalue : undefined,
          error:  state === 'failed' ? job.failedReason : undefined,
        };
      })
    );

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

  // POST /v1/queue/retry — retry all failed jobs
  fastify.post('/v1/queue/retry', async () => {
    const queue = getQueue();
    const failedJobs = await queue.getFailed(0, -1);
    await Promise.all(failedJobs.map(job => job.retry()));
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

  // DELETE /v1/queue/failed — drain (remove) all failed jobs
  fastify.delete('/v1/queue/failed', async () => {
    const queue = getQueue();
    const failedJobs = await queue.getFailed(0, -1);
    await Promise.all(failedJobs.map(job => job.remove()));
    return { drained: failedJobs.length };
  });

  // DELETE /v1/queue/completed — drain (remove) all completed jobs
  fastify.delete('/v1/queue/completed', async () => {
    const queue = getQueue();
    const completedJobs = await queue.getCompleted(0, -1);
    await Promise.all(completedJobs.map(job => job.remove()));
    return { drained: completedJobs.length };
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
