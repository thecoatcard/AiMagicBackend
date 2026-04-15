import { createReadStream, existsSync } from 'fs';
import { getAllSystemConfig } from '../redis/systemConfig.js';

export async function systemRoutes(fastify) {
  // ── GET /v1/system/payment-details ─────────────────────────────────────────
  fastify.get('/v1/system/payment-details', async () => {
    const cfg = await getAllSystemConfig();
    return {
      upi_1: cfg.payment_upi_1 || '',
      upi_2: cfg.payment_upi_2 || '',
      has_qr: !!cfg.payment_qr_path,
    };
  });

  // ── GET /v1/system/payment-qr ──────────────────────────────────────────────
  fastify.get('/v1/system/payment-qr', async (request, reply) => {
    const cfg = await getAllSystemConfig();
    const qrPath = cfg.payment_qr_path;

    if (!qrPath || !existsSync(qrPath)) {
      reply.status(404);
      return { error: 'QR code not found', code: 'QR_NOT_FOUND' };
    }

    // Determine content type based on extension
    const ext = qrPath.split('.').pop().toLowerCase();
    const mimeTypes = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
    };
    reply.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    return reply.send(createReadStream(qrPath));
  });
}
