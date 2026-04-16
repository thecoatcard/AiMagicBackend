import { randomUUID } from 'crypto';
import { getQueue, getQueueEvents } from '../queue/index.js';
import { checkUserRateLimit } from '../middleware/rateLimiter.js';

// Accepted image MIME types
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// Shared image schema used by both generate and stream routes
const imagesSchema = {
  type: 'array',
  maxItems: 16,
  items: {
    type: 'object',
    required: ['mimeType'],
    properties: {
      type:     { type: 'string', enum: ['base64', 'url'], default: 'base64' },
      mimeType: { type: 'string', enum: IMAGE_MIME_TYPES },
      data:     { type: 'string', minLength: 1, description: 'Base64-encoded image bytes (required when type is base64)' },
      url:      { type: 'string', minLength: 8, description: 'HTTPS image URL (required when type is url)' },
    },
  },
};

// Shared conversation history schema used by both generate and stream routes
const historySchema = {
  type: 'array',
  maxItems: 200,
  items: {
    type: 'object',
    required: ['role', 'text'],
    properties: {
      role: { type: 'string', enum: ['user', 'model'] },
      text: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
};

export { imagesSchema, historySchema };

export async function generateRoutes(fastify) {
  fastify.post('/v1/generate', {
    preHandler: checkUserRateLimit,
    schema: {
      body: {
        type: 'object',
        // prompt OR images (or both) must be present — enforced in handler
        properties: {
          prompt:            { type: 'string', minLength: 1 },
          images:            imagesSchema,
          model:             { type: 'string' },
          temperature:       { type: 'number', minimum: 0, maximum: 2 },
          maxOutputTokens:   { type: 'integer', minimum: 1 },
          systemInstruction: { type: 'string', minLength: 1, maxLength: 8192 },
          history:           historySchema,
          thinkingBudget:    { type: 'integer', minimum: 0, maximum: 24576 },
        },
      },
    },
  }, async (request, reply) => {
    const { prompt, images, model, temperature, maxOutputTokens,
            systemInstruction, history, thinkingBudget } = request.body;

    // Must have at least one content part
    if (!prompt && (!images || images.length === 0)) {
      reply.status(400);
      return { error: 'Either prompt or images (or both) must be provided', code: 'BAD_REQUEST' };
    }

    // Validate: base64 images must have data; url images must have url
    if (images) {
      for (const img of images) {
        const t = img.type ?? 'base64';
        if (t === 'base64' && !img.data) {
          reply.status(400);
          return { error: 'Images of type "base64" must include a "data" field', code: 'BAD_REQUEST' };
        }
        if (t === 'url' && !img.url) {
          reply.status(400);
          return { error: 'Images of type "url" must include a "url" field', code: 'BAD_REQUEST' };
        }
        if (t === 'url' && !img.url.startsWith('https://')) {
          reply.status(400);
          return { error: 'Image URLs must use HTTPS', code: 'BAD_REQUEST' };
        }
      }
    }

    const options = {};
    if (temperature        !== undefined) options.temperature        = temperature;
    if (maxOutputTokens    !== undefined) options.maxOutputTokens    = maxOutputTokens;
    if (images?.length)                   options.images             = images;
    if (systemInstruction)                options.systemInstruction  = systemInstruction;
    if (history?.length)                  options.history            = history;
    if (thinkingBudget     !== undefined) options.thinkingBudget     = thinkingBudget;

    const requestId = randomUUID();
    const queue = getQueue();
    const queueEvents = getQueueEvents();

    const job = await queue.add(
      `single-${requestId}`,
      { prompt: prompt ?? '', model, options, requestId, userEmail: request.user?.email },
      { jobId: requestId }
    );

    try {
      // Wait for the job to complete with a safety timeout (55s)
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('QUEUE_TIMEOUT')), 55000)
      );

      const result = await Promise.race([
        job.waitUntilFinished(queueEvents),
        timeoutPromise
      ]);

      if (result.error) {
        reply.status(result.httpStatus ?? 500);
      }
      
      const { httpStatus: _, ...response } = result;
      return response;
    } catch (err) {
      if (err.message === 'QUEUE_TIMEOUT') {
        reply.status(504).send({ 
          error: 'Request timed out in queue. The server is currently under high load.', 
          code: 'QUEUE_TIMEOUT',
          request_id: requestId
        });
        return;
      }
      throw err;
    }
  });
}
