import { 
  createAnnouncement, 
  listAllAnnouncements, 
  deleteAnnouncement 
} from '../../db/announcements.js';
import { listUsersFiltered } from '../../db/users.js';
import { sendEmail } from '../../services/email.js';
import { marked } from 'marked';

export async function adminAnnouncementsRoutes(fastify) {
  // ── POST /v1/admin/announcements — Create and send announcement (Owner only) ──
  fastify.post('/v1/admin/announcements', {
    schema: {
      body: {
        type: 'object',
        required: ['title', 'content', 'target_audience'],
        properties: {
          title: { type: 'string', minLength: 1 },
          content: { type: 'string', minLength: 1 },
          target_audience: { type: 'string', enum: ['all', 'premium'] },
        },
      },
    },
  }, async (request, reply) => {
    const { title, content, target_audience } = request.body;
    const created_by = request.user.email;

    // 1. Save to DB
    const announcement = await createAnnouncement({ 
      title, 
      content, 
      target_audience, 
      created_by 
    });

    // 2. Fetch target users for email
    const filter = {};
    if (target_audience === 'premium') {
      filter.plan = 'premium';
    }
    
    // We fetch users in batches to avoid memory issues if there are many
    let skip = 0;
    const limit = 100;
    let hasMore = true;

    // Convert Markdown to HTML for email
    const htmlContent = marked.parse(content);

    // Fire-and-forget email sending
    (async () => {
      while (hasMore) {
        const { users } = await listUsersFiltered({ ...filter, skip, limit });
        if (users.length === 0) {
          hasMore = false;
          break;
        }

        for (const user of users) {
          try {
            await sendEmail(user.email, 'broadcast', {
              title,
              content: htmlContent, // Send rendered HTML to the email template
              rawContent: content   // Also send raw markdown if needed
            });
          } catch (err) {
            fastify.log.warn(`[Announcements] Failed to send email to ${user.email}: ${err.message}`);
          }
        }

        skip += limit;
        if (users.length < limit) hasMore = false;
      }
    })().catch(err => {
      fastify.log.error(`[Announcements] Background email processing failed: ${err.message}`);
    });

    return announcement;
  });

  // ── GET /v1/admin/announcements — List all announcements (Owner only) ──
  fastify.get('/v1/admin/announcements', async () => {
    return await listAllAnnouncements();
  });

  // ── DELETE /v1/admin/announcements/:id — Delete an announcement (Owner only) ──
  fastify.delete('/v1/admin/announcements/:id', async (request, reply) => {
    const { id } = request.params;
    const deleted = await deleteAnnouncement(id);
    if (!deleted) {
      reply.status(404);
      return { error: 'Announcement not found' };
    }
    return { success: true };
  });
}
