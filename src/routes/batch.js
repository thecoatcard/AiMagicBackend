import { randomUUID } from 'crypto';
import { getQueue } from '../queue/index.js';
import { checkBatchRateLimit } from '../middleware/rateLimiter.js';

export async function batchRoutes(fastify) {
  fastify.post('/v1/generate/batch', {
    preHandler: checkBatchRateLimit,
    schema: {
      body: {
        type: 'object',
        required: ['prompts'],
        properties: {
          prompts: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            minItems: 1,
            maxItems: 100,
          },
          model:           { type: 'string' },
          temperature:     { type: 'number', minimum: 0, maximum: 2 },
          maxOutputTokens: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (request) => {
    const { prompts, model, temperature, maxOutputTokens } = request.body;
    const options = {};
    if (temperature !== undefined) options.temperature = temperature;
    if (maxOutputTokens !== undefined) options.maxOutputTokens = maxOutputTokens;

    const batchId = randomUUID();
    const queue = getQueue();

    const jobs = await Promise.all(
      prompts.map((prompt, i) => {
        const requestId = randomUUID();
        return queue.add(
          `batch-${batchId}-${i}`,
          { prompt, model, options, requestId, batchId, prompt_index: i, userEmail: request.user?.email },
          { jobId: requestId }
        ).then(job => ({ job_id: job.id, request_id: requestId, prompt_index: i }));
      })
    );

    return {
      batch_id: batchId,
      total: jobs.length,
      jobs,
      status_url: `/v1/queue/batch/${batchId}`,
    };
  });

  // Poll result for a single job
  fastify.get('/v1/generate/batch/:jobId', async (request, reply) => {
    const { jobId } = request.params;
    const queue = getQueue();
    const job = await queue.getJob(jobId);

    if (!job) {
      reply.status(404);
      return { error: 'Job not found', job_id: jobId };
    }

    const state = await job.getState();
    const response = { job_id: jobId, state };

    if (state === 'completed') {
      response.result = job.returnvalue;
    } else if (state === 'failed') {
      response.error = job.failedReason;
      response.attempts = job.attemptsMade;
    }

    return response;
  });
}
