import { createReadStream, existsSync } from 'fs';
import path from 'path';
import { ObjectId } from 'mongodb';
import { getAllSystemConfig } from '../redis/systemConfig.js';
import { getToolsBucket } from '../db/gridfs.js';

export async function systemRoutes(fastify) {
  // ── GET /v1/system/payment-details ─────────────────────────────────────────
  fastify.get('/v1/system/payment-details', async () => {
    const cfg = await getAllSystemConfig();
    return {
      upi_1: cfg.payment_upi_1 || '',
      upi_2: cfg.payment_upi_2 || '',
      has_qr: !!(cfg.payment_qr_file_id || cfg.payment_qr_path),
      qr_id: cfg.payment_qr_file_id || (cfg.payment_qr_path ? cfg.payment_qr_path.split(/[\\/]/).pop() : null),
    };
  });

  // ── GET /v1/system/payment-qr ──────────────────────────────────────────────
  fastify.get('/v1/system/payment-qr', async (request, reply) => {
    const cfg = await getAllSystemConfig();
    
    // 1. Prefer GridFS
    if (cfg.payment_qr_file_id) {
      const bucket = await getToolsBucket();
      try {
        const fileId = new ObjectId(cfg.payment_qr_file_id);
        const downloadStream = bucket.openDownloadStream(fileId);
        
        // Try to get mime type from GridFS metadata if saved
        reply.header('Content-Type', 'image/png'); // Default, browser will usually handle it anyway
        return reply.send(downloadStream);
      } catch (err) {
        // Fall through to disk or 404
      }
    }

    // 2. Fallback to disk (Legacy)
    const qrPath = cfg.payment_qr_path;
    if (qrPath && existsSync(qrPath)) {
      const normalizedPath = path.resolve(qrPath);
      const uploadsDir = path.resolve('uploads');
      if (!normalizedPath.startsWith(uploadsDir + path.sep) && normalizedPath !== uploadsDir) {
        reply.status(403);
        return { error: 'Forbidden: invalid file path', code: 'FORBIDDEN' };
      }
      const ext = qrPath.split('.').pop().toLowerCase();
      const mimeTypes = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
      };
      reply.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      return reply.send(createReadStream(qrPath));
    }

    reply.status(404);
    return { error: 'QR code not found', code: 'QR_NOT_FOUND' };
  });
}
