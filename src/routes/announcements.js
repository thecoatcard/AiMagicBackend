import { listAnnouncementsForUser } from '../db/announcements.js';
import { getUser } from '../db/users.js';

export async function announcementsRoutes(fastify) {
  // ── GET /v1/announcements — List announcements for current user ──
  fastify.get('/v1/announcements', async (request) => {
    const user = await getUser(request.user.email);
    const plan = user?.plan || 'free';
    return await listAnnouncementsForUser(plan);
  });
}
