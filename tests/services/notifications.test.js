import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/email.js', () => ({ sendEmail: vi.fn().mockResolvedValue({}) }));
vi.mock('../../src/services/alertThrottle.js', () => ({
  shouldSendAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../src/config.js', () => ({
  config: { ownerEmail: 'owner@test.com' },
}));
vi.mock('../../src/redis/systemConfig.js', () => ({
  getSystemConfig: vi.fn().mockResolvedValue('1'),
}));

import { sendEmail } from '../../src/services/email.js';
import {
  notifyNewDeviceLogin,
  notifyAccountBlocked,
  notifyAdminNoKeys,
  notifyQuotaWarning,
  notifyTicketCreated,
} from '../../src/services/notifications.js';
import { getSystemConfig } from '../../src/redis/systemConfig.js';

describe('notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSystemConfig.mockResolvedValue('1');
  });

  it('notifyNewDeviceLogin should send email', async () => {
    await notifyNewDeviceLogin('user@test.com');
    // fire-and-forget, give it a tick
    await new Promise(r => setTimeout(r, 10));
    expect(sendEmail).toHaveBeenCalledWith('user@test.com', 'newDeviceLogin', expect.any(Object));
  });

  it('notifyNewDeviceLogin should skip when email_security_enabled is 0', async () => {
    getSystemConfig.mockResolvedValue('0');
    await notifyNewDeviceLogin('user@test.com');
    await new Promise(r => setTimeout(r, 10));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('notifyAccountBlocked should send email', async () => {
    await notifyAccountBlocked('user@test.com');
    await new Promise(r => setTimeout(r, 10));
    expect(sendEmail).toHaveBeenCalledWith('user@test.com', 'accountBlocked', expect.any(Object));
  });

  it('notifyTicketCreated should send email', async () => {
    await notifyTicketCreated('user@test.com', { ticketId: 't1', subject: 'Bug', priority: 'high', description: 'desc' });
    await new Promise(r => setTimeout(r, 10));
    expect(sendEmail).toHaveBeenCalledWith('user@test.com', 'ticketCreated', expect.any(Object));
  });

  it('notifyQuotaWarning should skip when under 80%', async () => {
    await notifyQuotaWarning('user@test.com', { used: 3, limit: 10, resetInSeconds: 3600 });
    await new Promise(r => setTimeout(r, 10));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('notifyAdminNoKeys should send to owner', async () => {
    await notifyAdminNoKeys();
    await new Promise(r => setTimeout(r, 10));
    expect(sendEmail).toHaveBeenCalledWith('owner@test.com', 'adminNoKeys', expect.any(Object));
  });
});
