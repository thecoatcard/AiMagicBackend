import { listAuditLog } from '../../db/auditLog.js';

export async function adminAuditRoutes(fastify) {
  // ── GET /v1/admin/audit-log ────────────────────────────────────────────────
  fastify.get('/v1/admin/audit-log', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          actor_email:  { type: 'string' },
          action:       { type: 'string' },
          target_email: { type: 'string' },
          from:         { type: 'string' },
          to:           { type: 'string' },
          limit:        { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          skip:         { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { actor_email, action, target_email, from, to, limit, skip } = request.query;
    try {
      return await listAuditLog({
        actorEmail:  actor_email,
        action,
        targetEmail: target_email,
        from,
        to,
        limit,
        skip,
      });
    } catch {
      reply.status(503);
      return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }
  });
}
