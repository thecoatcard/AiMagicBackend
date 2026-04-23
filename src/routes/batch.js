import { randomUUID } from 'crypto';
import { getQueue } from '../queue/index.js';
import { checkBatchRateLimit } from '../middleware/rateLimiter.js';
import { createBatch } from '../db/batches.js';

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

    const jobs = prompts.map((prompt, i) => {
      const requestId = randomUUID();
      return queue.add(
        `batch-${batchId}-${i}`,
        { prompt, model, options, requestId, batchId, prompt_index: i, userEmail: request.user?.email },
        // attempts: 2 — orchestrator already retries internally, so queue-level
        // retries beyond 2 multiply work without improving success rate.
        { jobId: requestId, attempts: 2 }
      ).then(job => ({ job_id: job.id, request_id: requestId, prompt_index: i }));
    });

    const results = await Promise.all(jobs);
    
    // Persist batch metadata to MongoDB for fast, secure lookup
    await createBatch(batchId, {
      jobIds: results.map(j => j.job_id),
      userEmail: request.user?.email,
      total: results.length
    });

    return {
      batch_id: batchId,
      total: results.length,
      jobs: results,
      status_url: `/v1/queue/batch/${batchId}`,
    };
  });

}
