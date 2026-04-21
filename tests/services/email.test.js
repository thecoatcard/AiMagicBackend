import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    emailApiSecret: 'test-secret',
    frontendEmailUrl: 'http://localhost:3000/api/email/send',
  },
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { sendEmail } from '../../src/services/email.js';

describe('sendEmail()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send email with correct payload', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ success: true }),
    });
    const result = await sendEmail('user@test.com', 'otp', { otp: '123456' });
    expect(mockFetch).toHaveBeenCalled();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/email/send');
    const body = JSON.parse(opts.body);
    expect(body.to).toBe('user@test.com');
    expect(body.template).toBe('otp');
    expect(body.data.otp).toBe('123456');
  });

  it('should throw on HTTP error response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ error: 'Internal error' }),
    });
    await expect(sendEmail('user@test.com', 'otp', {})).rejects.toThrow('Internal error');
  });

  it('should early return when emailApiSecret is empty', async () => {
    const { config } = await import('../../src/config.js');
    config.emailApiSecret = '';
    await sendEmail('user@test.com', 'otp', {});
    expect(mockFetch).not.toHaveBeenCalled();
    config.emailApiSecret = 'test-secret'; // restore
  });

  it('should handle non-JSON response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      headers: { get: () => 'text/html' },
      text: () => Promise.resolve('Bad Gateway'),
    });
    await expect(sendEmail('user@test.com', 'otp', {})).rejects.toThrow();
  });
});
