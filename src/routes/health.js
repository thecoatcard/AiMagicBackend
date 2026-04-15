import { getRedis } from '../redis/client.js';

export async function healthRoutes(fastify) {
  fastify.get('/health', async () => {
    return { status: 'ok' };
  });

  fastify.get('/health/deep', async (request, reply) => {
    let redisStatus = 'ok';
    try {
      await getRedis().ping();
    } catch (err) {
      redisStatus = `error: ${err.message}`;
    }

    const healthy = redisStatus === 'ok';
    reply.status(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'degraded', redis: redisStatus };
  });
}
