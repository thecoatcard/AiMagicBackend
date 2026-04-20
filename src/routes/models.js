import { listAllModels, getModelStats, resetModelStats } from '../redis/modelHealth.js';
import {
  getModelConfig,
  updateModelConfig,
  addFallbackModel,
  removeFallbackModel,
  getFallbackModels,
  getImageModels,
} from '../redis/modelConfig.js';
import { requireOwner } from '../auth/roles.js';

export async function modelsRoutes(fastify) {
  // ── Public/User authenticated ─────────────────────────────────────────────

  // GET /v1/models/available — returns flat array of model names for dropdowns
  fastify.get('/v1/models/available', async () => {
    const [stats, configModels] = await Promise.all([
      listAllModels(),
      getFallbackModels()
    ]);
    
    // Combine models with health data + models in admin config chain
    const allModels = new Set([
      ...stats.map(s => s.model),
      ...configModels
    ]);

    return { models: Array.from(allModels) };
  });

  // ── Admin-only ────────────────────────────────────────────────────────────

  // GET /v1/models — live health stats for all models
  fastify.get('/v1/models', { preHandler: [requireOwner] }, async () => {
    return { models: await listAllModels() };
  });

  // GET /v1/models/:name/stats — stats for one model
  fastify.get('/v1/models/:name/stats', { preHandler: [requireOwner] }, async (request, reply) => {
    const stats = await getModelStats(request.params.name);
    if (!stats.last_updated) {
      reply.status(404);
      return { error: 'No data for this model yet' };
    }
    return stats;
  });

  // PATCH /v1/models/:name — reset health counters
  fastify.patch('/v1/models/:name', {
    preHandler: [requireOwner],
    schema: {
      body: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['reset'] },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params;
    if (request.body.action === 'reset') {
      await resetModelStats(name);
      return { status: 'reset', model: name };
    }
    reply.status(400);
    return { error: `Unknown action: ${request.body.action}`, code: 'BAD_ACTION' };
  });

  // ── Fallback chain config ─────────────────────────────────────────────────

  // GET /v1/models/config — view primary model and ordered fallback chain
  fastify.get('/v1/models/config', { preHandler: [requireOwner] }, async () => {
    return await getModelConfig();
  });

  // PATCH /v1/models/config — update primary model and/or replace entire fallback list
  fastify.patch('/v1/models/config', {
    preHandler: [requireOwner],
    schema: {
      body: {
        type: 'object',
        properties: {
          primary_model:   { type: 'string', minLength: 1 },
          fallback_models: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { primary_model, fallback_models } = request.body ?? {};
    if (!primary_model && !fallback_models) {
      reply.status(400);
      return { error: 'Provide at least one of primary_model or fallback_models', code: 'BAD_REQUEST' };
    }
    await updateModelConfig({ primaryModel: primary_model, fallbackModels: fallback_models });
    return await getModelConfig();
  });

  // POST /v1/models/config/fallback — add a model to the fallback chain
  fastify.post('/v1/models/config/fallback', {
    preHandler: [requireOwner],
    schema: {
      body: {
        type: 'object',
        required: ['model'],
        properties: {
          model:    { type: 'string', minLength: 1 },
          position: { type: 'string', enum: ['start', 'end'] },
        },
      },
    },
  }, async (request, reply) => {
    const { model, position = 'end' } = request.body;
    const result = await addFallbackModel(model, position);
    if (!result.added) {
      reply.status(409);
      return { error: 'Model already in fallback list', code: 'ALREADY_EXISTS', model };
    }
    return { added: true, model, ...(await getModelConfig()) };
  });

  // DELETE /v1/models/config/fallback/:name — remove a model from the fallback chain
  fastify.delete('/v1/models/config/fallback/:name', { preHandler: [requireOwner] }, async (request, reply) => {
    const { name } = request.params;
    const result = await removeFallbackModel(name);
    if (!result.removed) {
      reply.status(404);
      return { error: 'Model not in fallback list', code: 'NOT_FOUND', model: name };
    }
    return { removed: true, model: name, ...(await getModelConfig()) };
  });

  // ── Image model config ────────────────────────────────────────────────────

  // GET /v1/models/config/image — view image generation models
  fastify.get('/v1/models/config/image', { preHandler: [requireOwner] }, async () => {
    return { image_models: await getImageModels() };
  });

  // PUT /v1/models/config/image — replace entire image models list
  fastify.put('/v1/models/config/image', {
    preHandler: [requireOwner],
    schema: {
      body: {
        type: 'object',
        required: ['image_models'],
        properties: {
          image_models: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { image_models } = request.body;
    const redis = (await import('../redis/client.js')).getRedis();
    await redis.hset('model:config', 'image_models', JSON.stringify(image_models));
    const { savePersistentConfig } = await import('../db/config.js');
    await savePersistentConfig('image_models', { image_models });
    return { image_models };
  });
}
