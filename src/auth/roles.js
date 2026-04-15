/**
 * Fastify preHandler — restricts access to admin or owner role.
 * Must run after authenticate() which sets request.user.
 */
export async function requireAdmin(request, reply) {
  const role = request.user?.role;
  if (role !== 'admin' && role !== 'owner') {
    reply.status(403).send({ error: 'Forbidden: Admin only', code: 'FORBIDDEN' });
  }
}

/**
 * Fastify preHandler — restricts access to owner role only.
 * Owners are the only ones who can promote/demote other users to admin.
 */
export async function requireOwner(request, reply) {
  if (request.user?.role !== 'owner') {
    reply.status(403).send({ error: 'Forbidden: Owner only', code: 'FORBIDDEN' });
  }
}

/**
 * Factory: returns a preHandler that requires a specific role.
 *
 * @param {'owner'|'admin'|'user'} role
 */
export function requireRole(role) {
  return async function roleGuard(request, reply) {
    if (!request.user || request.user.role !== role) {
      reply.status(403).send({ error: `Forbidden: ${role} role required`, code: 'FORBIDDEN' });
    }
  };
}
