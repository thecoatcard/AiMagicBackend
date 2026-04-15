import nodemailer from 'nodemailer';
import { config } from '../config.js';

let _transporter;

function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: config.emailUser,
        pass: config.emailPass,
      },
    });
  }
  return _transporter;
}

/**
 * Generic email sender — used by the notifications layer.
 *
 * @param {string} to          - recipient address
 * @param {{ subject: string, html: string, text?: string }} opts
 */
export async function sendEmail(to, { subject, html, text }) {
  await getTransporter().sendMail({
    from: `"Gemini Proxy" <${config.emailUser}>`,
    to,
    subject,
    text: text ?? subject, // plain-text fallback
    html,
  });
}
