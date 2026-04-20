import { isMaintenanceMode, isGenerationEnabled } from '../redis/systemConfig.js';

/**
 * Fastify preHandler — returns 503 for all non-admin users while maintenance mode is on.
 * Admins and owners bypass maintenance mode so they can still access the system.
 */
export async function checkMaintenanceMode(request, reply) {
  const role = request.user?.role;
  if (role === 'admin' || role === 'owner') return; // bypass for staff

  const inMaintenance = await isMaintenanceMode();
  if (inMaintenance) {
    return reply.status(503).send({
      error: 'Service is temporarily under maintenance. Please try again later.',
      code:  'MAINTENANCE_MODE',
    });
  }
}

/**
 * Fastify preHandler — returns 503 for ALL users (including admins) when generation is off.
 * Used specifically on generate/stream/batch routes.
 */
export async function checkGenerationEnabled(request, reply) {
  const enabled = await isGenerationEnabled();
  if (!enabled) {
    return reply.status(503).send({
      error: 'Content generation is temporarily disabled by the administrator.',
      code:  'GENERATION_DISABLED',
    });
  }
}
