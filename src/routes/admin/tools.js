import { extname } from 'path';
import { getToolsBucket } from '../../db/gridfs.js';
import {
  createTool,
  getTool,
  updateTool,
  deleteTool,
  toggleToolActive,
} from '../../db/tools.js';
import { writeAuditLog } from '../../db/auditLog.js';

export async function adminToolsRoutes(fastify) {
  // ── POST /v1/admin/tools — create a tool ────────────────────────────────────
  fastify.post('/v1/admin/tools', async (request, reply) => {
    let toolData;

    if (request.isMultipart()) {
      // ── Multipart upload path ──
      const parts = request.parts();
      const fields = {};
      let savedFileId = null;
      let savedFileName = null;
      let savedFileSize = 0;

      for await (const part of parts) {
        if (part.type === 'file') {
          savedFileName = part.filename;
          const ext = extname(savedFileName).toLowerCase();
          if (ext !== '.zip') {
            reply.status(400);
            return { error: 'Only .zip files are allowed', code: 'INVALID_FILE_TYPE' };
          }

          const bucket = await getToolsBucket();
          const uploadStream = bucket.openUploadStream(savedFileName, {
            contentType: 'application/zip',
          });

          await new Promise((resolve, reject) => {
            part.file.pipe(uploadStream);
            uploadStream.on('finish', resolve);
            uploadStream.on('error', reject);
          });

          savedFileId = uploadStream.id;
          savedFileSize = uploadStream.length;
        } else {
          fields[part.fieldname] = part.value;
        }
      }

      if (!savedFileId) {
        reply.status(400);
        return { error: 'A zip file attachment is required for zip-type tools', code: 'MISSING_FILE' };
      }
      if (!fields.name || !fields.description) {
        // Cleanup GridFS if metadata is missing
        const bucket = await getToolsBucket();
        try { await bucket.delete(savedFileId); } catch {}
        reply.status(400);
        return { error: 'name and description are required', code: 'MISSING_FIELDS' };
      }

      // Parse tags BEFORE attempting createTool so a malformed JSON payload
      // doesn't leave the uploaded blob orphaned in GridFS.
      let parsedTags = [];
      if (fields.tags) {
        try {
          parsedTags = JSON.parse(fields.tags);
        } catch {
          const bucket = await getToolsBucket();
          bucket.delete(savedFileId).catch(() => {});
          reply.status(400);
          return { error: 'tags must be valid JSON', code: 'INVALID_TAGS' };
        }
      }

      toolData = {
        name:        fields.name,
        description: fields.description,
        icon:        fields.icon        ?? null,
        version:     fields.version     ?? null,
        tags:        parsedTags,
        type:        'zip',
        file_id:     savedFileId.toString(),
        file_name:   savedFileName,
        file_size:   savedFileSize,
        created_by:  request.user.email,
      };
    } else {
      // ── JSON / external link path ──
      const { name, description, icon, external_url, version, tags } = request.body ?? {};

      if (!name || !description) {
        reply.status(400);
        return { error: 'name and description are required', code: 'MISSING_FIELDS' };
      }
      if (!external_url) {
        reply.status(400);
        return { error: 'external_url is required for external-type tools', code: 'MISSING_EXTERNAL_URL' };
      }

      toolData = {
        name,
        description,
        icon:         icon         ?? null,
        version:      version      ?? null,
        tags:         tags         ?? [],
        type:         'external',
        external_url,
        created_by:   request.user.email,
      };
    }

    let tool;
    try {
      tool = await createTool(toolData);
    } catch (err) {
      // Any post-upload failure must clean up the GridFS blob to prevent
      // orphan files (duplicate-name 11000, validation, transient DB error, etc.)
      if (toolData.file_id) {
        try {
          const bucket = await getToolsBucket();
          await bucket.delete(savedFileId);
        } catch {}
      }
      if (err.code === 11000) {
        reply.status(409);
        return { error: 'A tool with that name already exists', code: 'DUPLICATE_NAME' };
      }
      reply.status(503);
      return { error: 'Database unavailable', code: 'DB_UNAVAILABLE' };
    }

    writeAuditLog({ actorEmail: request.user.email, action: 'create_tool', meta: { toolId: tool.id, name: tool.name, type: tool.type } });
    reply.status(201);
    return tool;
  });

  // ── PATCH /v1/admin/tools/:id — update metadata ─────────────────────────────
  fastify.patch('/v1/admin/tools/:id', {
    schema: {
      body: {
        type: 'object',
        minProperties: 1,
        properties: {
          name:         { type: 'string', minLength: 1, maxLength: 200 },
          description:  { type: 'string', minLength: 1, maxLength: 2000 },
          icon:         { type: 'string' },
          external_url: { type: 'string' },
          version:      { type: 'string', maxLength: 50 },
          tags:         { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const updated = await updateTool(request.params.id, request.body);
    if (!updated) {
      reply.status(404);
      return { error: 'Tool not found', id: request.params.id };
    }
    writeAuditLog({ actorEmail: request.user.email, action: 'update_tool', meta: { toolId: updated.id } });
    return updated;
  });

  // ── PATCH /v1/admin/tools/:id/toggle — toggle active state ─────────────────
  fastify.patch('/v1/admin/tools/:id/toggle', async (request, reply) => {
    const updated = await toggleToolActive(request.params.id);
    if (!updated) {
      reply.status(404);
      return { error: 'Tool not found', id: request.params.id };
    }
    writeAuditLog({ actorEmail: request.user.email, action: 'toggle_tool', meta: { toolId: updated.id, is_active: updated.is_active } });
    return { id: updated.id, is_active: updated.is_active };
  });

  // ── DELETE /v1/admin/tools/:id — delete tool ────────────────────────────────
  fastify.delete('/v1/admin/tools/:id', async (request, reply) => {
    // Fetch first so we can verify existence
    const tool = await getTool(request.params.id);
    if (!tool) {
      reply.status(404);
      return { error: 'Tool not found', id: request.params.id };
    }

    // deleteTool helper already cleans up GridFS file_id
    await deleteTool(request.params.id);
    writeAuditLog({ actorEmail: request.user.email, action: 'delete_tool', meta: { toolId: tool.id, name: tool.name } });
    reply.status(204);
    return '';
  });
}
