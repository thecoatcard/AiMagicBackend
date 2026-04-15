import {
  createTicket,
  getTicketById,
  listTickets,
  updateTicket,
  deleteTicket,
  getTicketStats,
  bulkCloseTickets,
} from '../db/tickets.js';
import { requireAdmin } from '../auth/roles.js';
import {
  notifyTicketCreated,
  notifyTicketReply,
  notifyTicketClosed,
  notifyAdminNewTicket,
} from '../services/notifications.js';
import { writeAuditLog } from '../db/auditLog.js';

const VALID_STATUSES   = ['open', 'in_progress', 'resolved', 'closed'];
const VALID_PRIORITIES = ['low', 'medium', 'high'];

export async function ticketsRoutes(fastify) {
  // ── POST /v1/tickets — create a ticket (any authenticated user) ────────────
  fastify.post('/v1/tickets', {
    schema: {
      body: {
        type: 'object',
        required: ['subject', 'description'],
        properties: {
          subject:     { type: 'string', minLength: 3,  maxLength: 200 },
          description: { type: 'string', minLength: 10, maxLength: 5000 },
          priority:    { type: 'string', enum: VALID_PRIORITIES },
        },
      },
    },
  }, async (request, reply) => {
    const { subject, description, priority } = request.body;
    let ticket;
    try {
      ticket = await createTicket({
        userEmail: request.user.email,
        subject,
        description,
        priority,
      });
    } catch (err) {
      reply.status(503);
      return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }
    // Notify user that their ticket was received, and alert the admin
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

  // ── GET /v1/tickets/stats — ticket statistics (admin only) ───────────────
  fastify.get('/v1/tickets/stats', {
    preHandler: requireAdmin,
  }, async (request, reply) => {
    try {
      return getTicketStats();
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

  // ── DELETE /v1/tickets/:id — delete ticket (admin only) ───────────────────
  fastify.delete('/v1/tickets/:id', {
    preHandler: requireAdmin,
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
