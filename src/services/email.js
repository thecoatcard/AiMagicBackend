import { config } from '../config.js';

/**
 * Sends an email by calling the Frontend's email API.
 * 
 * @param {string} to - Recipient address
 * @param {string} template - Name of the template to use
 * @param {object} data - Data to pass to the template
 */
export async function sendEmail(to, template, data = {}) {
  if (!config.emailApiSecret) {
    console.error('[email] EMAIL_API_SECRET is not set. Cannot send email.');
    return;
  }

  let url;
  try {
    // Extract origin to avoid issues if user provides a URL with a path (e.g., /login)
    const base = new URL(config.frontendEmailUrl).origin;
    url = `${base}/api/email/send`;
  } catch (e) {
    // Fallback if URL parsing fails (e.g. if it's just a hostname)
    url = config.frontendEmailUrl.replace(/\/$/, '') + '/api/email/send';
  }


  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.emailApiSecret}`
      },
      body: JSON.stringify({ to, template, data })
    });

    let result;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      result = await response.json();
    } else {
      const text = await response.text();
      result = { error: text.slice(0, 200) };
    }


    if (!response.ok) {
      throw new Error(result.error || `HTTP error ${response.status}`);
    }

    return result;
  } catch (err) {
    console.error(`[email] Failed to send ${template} email to ${to}:`, err.message);
    throw err;
  }
}
