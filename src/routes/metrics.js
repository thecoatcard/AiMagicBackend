import { registry } from '../metrics/index.js';

export async function metricsRoutes(fastify) {
  fastify.get('/v1/metrics', async (request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
}
