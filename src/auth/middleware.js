import { validateSession } from './session.js';
import { getUser } from '../db/users.js';
import { config } from '../config.js';
import jwt from 'jsonwebtoken';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Fastify preHandler hook — validates Bearer JWT on all /v1/* routes.
 * Attaches { email, sessionId, role, impersonated? } to request.user on success.
 * Also checks that the user's account is not blocked.
 *
 * Impersonation: if the JWT payload contains { impersonated: true }, the
 * Redis session check is skipped (impersonation tokens are self-contained).
 * Impersonated sessions are read-only — mutating HTTP methods (POST/PUT/PATCH/DELETE)
 * are blocked.
 */
export async function authenticate(request, reply) {
  let token = null;
  const authHeader = request.headers['authorization'];

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (request.query?.token) {
    token = request.query.token;
  }

  if (!token) {
    reply.status(401).send({ error: 'Missing or malformed Authorization header', code: 'UNAUTHORIZED' });
    return;
  }

  // ── Fast path: check if this is an impersonation token ───────────────────
  let rawPayload;
  try {
    rawPayload = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    reply.status(401).send({
      error: err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token',
      code: 'UNAUTHORIZED',
    });
    return;
  }

  if (rawPayload.impersonated) {
    // Block mutating actions for impersonated sessions
    if (MUTATING_METHODS.has(request.method)) {
      reply.status(403).send({ error: 'Impersonated sessions are read-only', code: 'IMPERSONATION_READ_ONLY' });
      return;
    }
    request.user = {
      email:        rawPayload.email,
      role:         rawPayload.role ?? 'user',
      impersonated: true,
      impersonator: rawPayload.impersonator,
    };
    return;
  }

  // ── Normal path: full session validation ─────────────────────────────────
  const result = await validateSession(token);

  if (!result.valid) {
    reply.status(401).send({ error: result.reason, code: 'UNAUTHORIZED' });
    return;
  }

  // Check blocked status from MongoDB (fail open if DB is unavailable)
  const userDoc = await getUser(result.email);
  if (userDoc?.status === 'blocked') {
    reply.status(403).send({ error: 'Account blocked', code: 'ACCOUNT_BLOCKED' });
    return;
  }

  // Determine role: JWT → DB fallback → default 'user'
  let role = result.role ?? userDoc?.role ?? 'user';

  // Owner override: always gets 'owner' role regardless of DB or JWT state.
  // Emergency safeguard — ensures lockout is impossible even if DB is corrupted.
  if (config.ownerEmail && result.email === config.ownerEmail) {
    role = 'owner';
  }

  request.user = {
    email:     result.email,
    sessionId: result.sessionId,
    role,
  };
}
