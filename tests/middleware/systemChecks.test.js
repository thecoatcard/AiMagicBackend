import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockReply, createMockRequest } from '../helpers/mocks.js';

vi.mock('../../src/redis/systemConfig.js', () => ({
  isMaintenanceMode: vi.fn(),
  isGenerationEnabled: vi.fn(),
}));

import { checkMaintenanceMode, checkGenerationEnabled } from '../../src/middleware/systemChecks.js';
import { isMaintenanceMode, isGenerationEnabled } from '../../src/redis/systemConfig.js';

describe('checkMaintenanceMode()', () => {
  let request, reply;

  beforeEach(() => {
    vi.clearAllMocks();
    request = createMockRequest();
    reply = createMockReply();
  });

  it('should bypass maintenance mode for admin', async () => {
    request.user = { role: 'admin' };
    isMaintenanceMode.mockResolvedValue(true);
    await checkMaintenanceMode(request, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('should bypass maintenance mode for owner', async () => {
    request.user = { role: 'owner' };
    isMaintenanceMode.mockResolvedValue(true);
    await checkMaintenanceMode(request, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('should return 503 for regular user during maintenance', async () => {
    request.user = { role: 'user' };
    isMaintenanceMode.mockResolvedValue(true);
    await checkMaintenanceMode(request, reply);
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply._body.code).toBe('MAINTENANCE_MODE');
  });

  it('should allow regular user when not in maintenance', async () => {
    request.user = { role: 'user' };
    isMaintenanceMode.mockResolvedValue(false);
    await checkMaintenanceMode(request, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });
});

describe('checkGenerationEnabled()', () => {
  let request, reply;

  beforeEach(() => {
    vi.clearAllMocks();
    request = createMockRequest();
    reply = createMockReply();
  });

  it('should return 503 when generation is disabled', async () => {
    isGenerationEnabled.mockResolvedValue(false);
    await checkGenerationEnabled(request, reply);
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply._body.code).toBe('GENERATION_DISABLED');
  });

  it('should allow when generation is enabled', async () => {
    isGenerationEnabled.mockResolvedValue(true);
    await checkGenerationEnabled(request, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('should block even admins when generation is disabled', async () => {
    request.user = { role: 'admin' };
    isGenerationEnabled.mockResolvedValue(false);
    await checkGenerationEnabled(request, reply);
    expect(reply.status).toHaveBeenCalledWith(503);
  });
});
