import { createReadStream, existsSync } from 'fs';
import { ObjectId } from 'mongodb';
import { getToolsBucket } from '../db/gridfs.js';
import { getTool, listTools, incrementDownloadCount } from '../db/tools.js';

export async function toolsRoutes(fastify) {
  // ── GET /v1/tools — list active tools ──────────────────────────────────────
  fastify.get('/v1/tools', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          skip:  { type: 'integer', minimum: 0, default: 0 },
          tag:   { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { limit, skip, tag } = request.query;
    const isAdmin = request.user.role === 'admin' || request.user.role === 'owner';

    try {
      // Admins see all tools (including inactive); regular users see only active
      return listTools({ activeOnly: !isAdmin, limit, skip, tag });
    } catch {
      reply.status(503);
      return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }
  });

  // ── GET /v1/tools/:id — get a single tool ───────────────────────────────────
  fastify.get('/v1/tools/:id', async (request, reply) => {
    const tool = await getTool(request.params.id);
    if (!tool) {
      reply.status(404);
      return { error: 'Tool not found', id: request.params.id };
    }

    const isAdmin = request.user.role === 'admin' || request.user.role === 'owner';
    if (!tool.is_active && !isAdmin) {
      reply.status(404);
      return { error: 'Tool not found', id: request.params.id };
    }

    return tool;
  });

  // ── GET /v1/tools/:id/download — download a tool ───────────────────────────
  //   External type → 302 redirect to external_url
  //   ZIP type      → stream the file with Content-Disposition header
  //   Both paths increment the download counter.
  fastify.get('/v1/tools/:id/download', async (request, reply) => {
    const tool = await getTool(request.params.id);
    if (!tool) {
      reply.status(404);
      return { error: 'Tool not found', id: request.params.id };
    }

    const isAdmin = request.user.role === 'admin' || request.user.role === 'owner';
    if (!tool.is_active && !isAdmin) {
      reply.status(404);
      return { error: 'Tool not found', id: request.params.id };
    }

    // Increment download count (fire-and-forget — don't block the response)
    incrementDownloadCount(tool.id).catch(() => {});

    if (tool.type === 'external') {
      if (!tool.external_url) {
        reply.status(502);
        return { error: 'External URL not configured', code: 'NO_EXTERNAL_URL' };
      }
      return reply.redirect(302, tool.external_url);
    }

    // ZIP type — stream file
    const filename = tool.file_name ?? `${tool.name.replace(/\s+/g, '_')}.zip`;
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    if (tool.file_size) {
      reply.header('Content-Length', tool.file_size);
    }

    if (tool.file_id) {
      // Stream from GridFS (New implementation)
      const bucket = await getToolsBucket();
      try {
        const downloadStream = bucket.openDownloadStream(new ObjectId(tool.file_id));
        
        downloadStream.on('error', (err) => {
          if (!reply.sent) {
            reply.status(404).send({ error: 'Tool file not found in database' });
          }
        });

        return reply.send(downloadStream);
      } catch (err) {
        reply.status(404);
        return { error: 'Tool file not found in database', code: 'FILE_NOT_FOUND' };
      }
    } else if (tool.file_path && existsSync(tool.file_path)) {
      // Stream from disk (Legacy implementation)
      return reply.send(createReadStream(tool.file_path));
    } else {
      reply.status(404);
      return { error: 'Tool file not found on server', code: 'FILE_NOT_FOUND' };
    }
  });
}
