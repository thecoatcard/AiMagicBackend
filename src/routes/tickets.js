import {
  createTicket,
  getTicketById,
  listTickets,
  updateTicket,
  deleteTicket,
  getTicketStats,
  bulkCloseTickets,
} from '../db/tickets.js';
import { requireAdmin, requireOwner } from '../auth/roles.js';
import {
  notifyTicketCreated,
  notifyTicketReply,
  notifyTicketClosed,
  notifyAdminNewTicket,
} from '../services/notifications.js';
import { writeAuditLog } from '../db/auditLog.js';
import { createReadStream, existsSync } from 'fs';
import { ObjectId } from 'mongodb';
import { getToolsBucket } from '../db/gridfs.js';

const VALID_STATUSES   = ['open', 'in_progress', 'resolved', 'closed'];
const VALID_PRIORITIES = ['low', 'medium', 'high'];

export async function ticketsRoutes(fastify) {
  // ── POST /v1/tickets — create a ticket (any authenticated user) ────────────
  fastify.post('/v1/tickets', async (request, reply) => {
    if (!request.isMultipart()) {
      reply.status(400);
      return { error: 'Request must be multipart/form-data', code: 'BAD_REQUEST' };
    }

    let subject, description, priority = 'medium', screenshotId = null;
    const parts = request.parts();

    const bucket = await getToolsBucket();

    for await (const part of parts) {
      if (part.type === 'file') {
        if (part.fieldname === 'screenshot') {
          const ext = part.filename.split('.').pop().toLowerCase();
          const allowed = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
          if (!allowed.includes(ext)) {
            reply.status(400);
            return { error: 'Invalid file type. Only JPG, PNG, and WebP are allowed.', code: 'INVALID_FILE' };
          }
          
          // Stream directly to GridFS
          const uploadStream = bucket.openUploadStream(part.filename, {
            contentType: part.mimetype || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
            metadata: { type: 'ticket_screenshot', user: request.user.email }
          });

          await new Promise((res, rej) => {
            part.file.pipe(uploadStream);
            uploadStream.on('finish', res);
            uploadStream.on('error', rej);
          });

          screenshotId = uploadStream.id.toString();
        }
      } else {
        if (part.fieldname === 'subject') subject = part.value;
        if (part.fieldname === 'description') description = part.value;
        if (part.fieldname === 'priority') priority = part.value;
      }
    }

    if (!subject || subject.length < 3) {
      reply.status(400);
      return { error: 'Subject is required (min 3 chars)', code: 'BAD_REQUEST' };
    }
    if (!description || description.length < 10) {
      reply.status(400);
      return { error: 'Description is required (min 10 chars)', code: 'BAD_REQUEST' };
    }

    let ticket;
    try {
      ticket = await createTicket({
        userEmail: request.user.email,
        subject,
        description,
        priority,
        screenshotId,
      });
    } catch (err) {
      reply.status(503);
      return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }

    notifyTicketCreated(request.user.email, {
      ticketId:    ticket.id,
      subject,
      priority:    ticket.priority,
      description,
    });
    notifyAdminNewTicket({
      ticketId:    ticket.id,
      userEmail:   request.user.email,
      subject,
      priority:    ticket.priority,
      description,
    });

    reply.status(201);
    return ticket;
  });

  fastify.get('/v1/tickets/:id/screenshot', async (request, reply) => {
    const ticket = await getTicketById(request.params.id);
    if (!ticket) {
      reply.status(404);
      return { error: 'Ticket not found', code: 'NOT_FOUND' };
    }

    // Auth check: Admin or owner of the ticket
    const isAdmin = request.user.role === 'admin' || request.user.role === 'owner';
    if (!isAdmin && ticket.user_email !== request.user.email) {
      reply.status(403);
      return { error: 'Forbidden', code: 'FORBIDDEN' };
    }

    // 1. Prefer GridFS
    if (ticket.screenshot_id) {
      const bucket = await getToolsBucket();
      try {
        const downloadStream = bucket.openDownloadStream(new ObjectId(ticket.screenshot_id));
        
        downloadStream.on('error', () => {
          if (!reply.sent) reply.status(404).send({ error: 'Screenshot not found in database' });
        });

        // We don't strictly know the content type here unless we query GridFS files, 
        // but image/png is a safe default for browser rendering of common formats.
        reply.header('Content-Type', 'image/png'); 
        return reply.send(downloadStream);
      } catch (err) {
        // Fall through
      }
    }

    // 2. Fallback to Disk (Legacy)
    if (ticket.screenshot_path && existsSync(ticket.screenshot_path)) {
      const ext = ticket.screenshot_path.split('.').pop().toLowerCase();
      const mimeTypesMapping = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
      };
      reply.header('Content-Type', mimeTypesMapping[ext] || 'application/octet-stream');
      return reply.send(createReadStream(ticket.screenshot_path));
    }

    reply.status(404);
    return { error: 'Screenshot not found', code: 'NOT_FOUND' };
  });

  // ── GET /v1/tickets/stats — ticket statistics (admin only) ───────────────
  fastify.get('/v1/tickets/stats', {
    preHandler: requireAdmin,
  }, async (request, reply) => {
    try {
      return await getTicketStats();
    } catch {
      reply.status(503);
      return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }
  });

  // ── POST /v1/tickets/bulk-close — bulk close/resolve tickets (admin only) ──
  fastify.post('/v1/tickets/bulk-close', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['ids', 'status'],
        properties: {
          ids:    { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
          status: { type: 'string', enum: ['resolved', 'closed'] },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const { ids, status } = request.body;
    const result = await bulkCloseTickets(ids, status);
    writeAuditLog({ actorEmail: request.user.email, action: `bulk_${status}_tickets`, meta: { ids, count: result.modified } });
    return result;
  });

  // ── GET /v1/tickets — list tickets ─────────────────────────────────────────
  //   Users see only their own tickets; admins see all (filterable by status).
  fastify.get('/v1/tickets', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status:   { type: 'string', enum: VALID_STATUSES },
          priority: { type: 'string', enum: VALID_PRIORITIES },
          limit:    { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          skip:     { type: 'integer', minimum: 0, default: 0 },
          // Admin-only filters
          email:    { type: 'string' },
          search:   { type: 'string', maxLength: 100 },
          from:     { type: 'string' },
          to:       { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { status, priority, limit, skip, email, search, from, to } = request.query;
    const isAdmin = request.user.role === 'admin' || request.user.role === 'owner';

    let userEmail;
    if (isAdmin && email) {
      userEmail = email; // admin filtering by specific user
    } else if (!isAdmin) {
      userEmail = request.user.email; // user always sees only their own
    }
    // isAdmin with no email filter → see all

    // Non-admins cannot use search/date filters
    const adminSearch = isAdmin ? search : undefined;
    const adminFrom   = isAdmin ? from   : undefined;
    const adminTo     = isAdmin ? to     : undefined;

    let result;
    try {
      result = await listTickets({ userEmail, status, priority, limit, skip, search: adminSearch, from: adminFrom, to: adminTo });
    } catch {
      reply.status(503);
      return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }
    return result;
  });

  // ── GET /v1/tickets/:id — get a single ticket ──────────────────────────────
  //   Users can only view their own tickets.
  fastify.get('/v1/tickets/:id', async (request, reply) => {
    const ticket = await getTicketById(request.params.id);

    if (!ticket) {
      reply.status(404);
      return { error: 'Ticket not found', id: request.params.id };
    }

    // Ownership check for non-admins
    if (request.user.role !== 'admin' && request.user.role !== 'owner' && ticket.user_email !== request.user.email) {
      reply.status(403);
      return { error: 'Forbidden', code: 'FORBIDDEN' };
    }

    return ticket;
  });

  // ── PATCH /v1/tickets/:id — update ticket status / add response (admin) ────
  fastify.patch('/v1/tickets/:id', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        minProperties: 1,
        properties: {
          status:         { type: 'string', enum: VALID_STATUSES },
          admin_response: { type: 'string', maxLength: 5000 },
          priority:       { type: 'string', enum: VALID_PRIORITIES },
          admin_notes:    { type: 'string', maxLength: 2000 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { status, admin_response, priority, admin_notes } = request.body;
    const updated = await updateTicket(request.params.id, { status, admin_response, priority, admin_notes });

    if (!updated) {
      reply.status(404);
      return { error: 'Ticket not found', id: request.params.id };
    }

    const userEmail = updated.user_email;
    const subject   = updated.subject;
    const ticketId  = updated.id;

    if (admin_response) {
      // Admin posted a reply — notify user with the response text
      notifyTicketReply(userEmail, { ticketId, subject, adminResponse: admin_response, status: updated.status });
    } else if (status === 'resolved' || status === 'closed') {
      // Status-only update that closes the ticket
      notifyTicketClosed(userEmail, { ticketId, subject, status });
    }

    writeAuditLog({
      actorEmail:  request.user.email,
      action:      'update_ticket',
      targetEmail: userEmail,
      meta:        { ticketId, status, priority, hasResponse: !!admin_response },
    });

    return updated;
  });

  // ── DELETE /v1/tickets/:id — delete ticket (owner only) ───────────────────
  fastify.delete('/v1/tickets/:id', {
    preHandler: requireOwner,
  }, async (request, reply) => {
    const deleted = await deleteTicket(request.params.id);

    if (!deleted) {
      reply.status(404);
      return { error: 'Ticket not found', id: request.params.id };
    }

    reply.status(204);
    return '';
  });
}
