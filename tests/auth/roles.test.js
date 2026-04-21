import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockReply, createMockRequest } from '../helpers/mocks.js';
import { requireAdmin, requireOwner, requireRole } from '../../src/auth/roles.js';

describe('requireAdmin()', () => {
  let request, reply;

  beforeEach(() => {
    request = createMockRequest();
    reply = createMockReply();
  });

  it('should allow admin role', async () => {
    request.user = { role: 'admin' };
    await requireAdmin(request, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('should allow owner role', async () => {
    request.user = { role: 'owner' };
    await requireAdmin(request, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('should reject user role', async () => {
    request.user = { role: 'user' };
    await requireAdmin(request, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply._body.code).toBe('FORBIDDEN');
  });

  it('should reject when user is not set', async () => {
    await requireAdmin(request, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
  });
});

describe('requireOwner()', () => {
  let request, reply;

  beforeEach(() => {
    request = createMockRequest();
    reply = createMockReply();
  });

  it('should allow owner role', async () => {
    request.user = { role: 'owner' };
    await requireOwner(request, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('should reject admin role', async () => {
    request.user = { role: 'admin' };
    await requireOwner(request, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('should reject user role', async () => {
    request.user = { role: 'user' };
    await requireOwner(request, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
  });
});

describe('requireRole()', () => {
  let request, reply;

  beforeEach(() => {
    request = createMockRequest();
    reply = createMockReply();
  });

  it('should return a function', () => {
    const guard = requireRole('admin');
    expect(typeof guard).toBe('function');
  });

  it('should allow matching role', async () => {
    request.user = { role: 'admin' };
    const guard = requireRole('admin');
    await guard(request, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('should reject non-matching role', async () => {
    request.user = { role: 'user' };
    const guard = requireRole('admin');
    await guard(request, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('should reject when user is missing', async () => {
    const guard = requireRole('user');
    await guard(request, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
  });
});
