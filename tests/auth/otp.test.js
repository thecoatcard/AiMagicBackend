import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRedis } from '../helpers/mocks.js';

const mockRedis = createMockRedis();
vi.mock('../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));
vi.mock('../../src/config.js', () => ({
  config: { otpTtlMs: 600000 },
}));

import { generateOtp, verifyOtp } from '../../src/auth/otp.js';

describe('generateOtp()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.pipeline.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    });
  });

  it('should return a 6-digit string', async () => {
    const otp = await generateOtp('user@test.com');
    expect(otp).toMatch(/^\d{6}$/);
  });

  it('should call pipeline to set OTP and reset attempts', async () => {
    await generateOtp('user@test.com');
    expect(mockRedis.pipeline).toHaveBeenCalled();
  });
});

describe('verifyOtp()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return valid=true on correct OTP (result=2)', async () => {
    mockRedis.eval.mockResolvedValue(2);
    const result = await verifyOtp('user@test.com', '123456');
    expect(result.valid).toBe(true);
  });

  it('should return too_many_attempts on result=-1', async () => {
    mockRedis.eval.mockResolvedValue(-1);
    const result = await verifyOtp('user@test.com', '123456');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('too_many_attempts');
  });

  it('should return otp_expired_or_not_found on result=0', async () => {
    mockRedis.eval.mockResolvedValue(0);
    const result = await verifyOtp('user@test.com', '123456');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('otp_expired_or_not_found');
  });

  it('should return invalid_otp on result=1', async () => {
    mockRedis.eval.mockResolvedValue(1);
    const result = await verifyOtp('user@test.com', '999999');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_otp');
  });
});
