import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import {
  createTool,
  getTool,
  updateTool,
  deleteTool,
  toggleToolActive,
} from '../../db/tools.js';
import { writeAuditLog } from '../../db/auditLog.js';

const UPLOADS_DIR = join(process.cwd(), 'uploads', 'tools');

// Ensure the upload directory exists on first use
function ensureUploadsDir() {
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

export async function adminToolsRoutes(fastify) {
  // ── POST /v1/admin/tools — create a tool ────────────────────────────────────
  // Supports two content types:
  //   1. multipart/form-data  — fields: name, description, icon, version, tags (JSON array string),
  //                             file attachment (zip)
  //   2. application/json     — same fields + external_url (no file)
  fastify.post('/v1/admin/tools', async (request, reply) => {
    let toolData;

    if (request.isMultipart) {
      // ── Multipart upload path ──
      ensureUploadsDir();

      const parts = request.parts();
      const fields = {};
      let savedFilePath = null;
      let savedFileName = null;
      let savedFileSize = 0;

      for await (const part of parts) {
        if (part.type === 'file') {
          const ext = extname(part.filename).toLowerCase();
          if (ext !== '.zip') {
            reply.status(400);
            return { error: 'Only .zip files are allowed', code: 'INVALID_FILE_TYPE' };
          }
          const uniqueName = `${randomUUID()}${ext}`;
          savedFilePath = join(UPLOADS_DIR, uniqueName);
          savedFileName = part.filename;

          let size = 0;
          const writeStream = createWriteStream(savedFilePath);
          for await (const chunk of part.file) {
            size += chunk.length;
            if (size > 100 * 1024 * 1024) {
              writeStream.destroy();
              try { unlinkSync(savedFilePath); } catch {}
              reply.status(413);
              return { error: 'File exceeds 100 MB limit', code: 'FILE_TOO_LARGE' };
            }
            writeStream.write(chunk);
          }
          await new Promise((res, rej) => {
            writeStream.end(err => (err ? rej(err) : res()));
          });
          savedFileSize = size;
        } else {
          fields[part.fieldname] = part.value;
        }
      }

      if (!savedFilePath) {
        reply.status(400);
        return { error: 'A zip file attachment is required for zip-type tools', code: 'MISSING_FILE' };
      }
      if (!fields.name || !fields.description) {
        try { unlinkSync(savedFilePath); } catch {}
        reply.status(400);
        return { error: 'name and description are required', code: 'MISSING_FIELDS' };
      }

      toolData = {
        name:        fields.name,
        description: fields.description,
        icon:        fields.icon        ?? null,
        version:     fields.version     ?? null,
        tags:        fields.tags ? JSON.parse(fields.tags) : [],
        type:        'zip',
        file_path:   savedFilePath,
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
    // Fetch first so we can clean up the file
    const tool = await getTool(request.params.id);
    if (!tool) {
      reply.status(404);
      return { error: 'Tool not found', id: request.params.id };
    }

    if (tool.type === 'zip' && tool.file_path) {
      try { unlinkSync(tool.file_path); } catch {}
    }

    await deleteTool(request.params.id);
    writeAuditLog({ actorEmail: request.user.email, action: 'delete_tool', meta: { toolId: tool.id, name: tool.name } });
    reply.status(204);
    return '';
  });
}
