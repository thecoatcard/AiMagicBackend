import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRedis } from '../helpers/mocks.js';

const mockRedis = createMockRedis();
vi.mock('../../src/redis/client.js', () => ({ getRedis: () => mockRedis }));
vi.mock('../../src/config.js', () => ({
  config: { otpTtlMs: 600000 },
}));

// Mock node:crypto.randomInt for deterministic OTP generation.
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual('node:crypto');
  return { ...actual, randomInt: vi.fn().mockReturnValue(123456) };
});

import { createOtpValue, persistOtp, generateOtp, verifyOtp } from '../../src/auth/otp.js';
import { randomInt } from 'node:crypto';

describe('createOtpValue()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return a 6-digit string', () => {
    const otp = createOtpValue();
    expect(otp).toMatch(/^\d{6}$/);
  });

  it('should call randomInt with [100000, 1000000)', () => {
    createOtpValue();
    expect(randomInt).toHaveBeenCalledWith(100000, 1000000);
  });

  it('should not touch Redis', () => {
    createOtpValue();
    expect(mockRedis.set).not.toHaveBeenCalled();
    expect(mockRedis.expire).not.toHaveBeenCalled();
    expect(mockRedis.del).not.toHaveBeenCalled();
  });
});

describe('persistOtp()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should SET the OTP key with EX TTL (seconds)', async () => {
    await persistOtp('user@test.com', '123456');
    expect(mockRedis.set).toHaveBeenCalledWith('otp:user@test.com', '123456', 'EX', 600);
  });

  it('should EXPIRE the attempts key with the same TTL (does not DEL it)', async () => {
    await persistOtp('user@test.com', '123456');
    expect(mockRedis.expire).toHaveBeenCalledWith('otp_attempts:user@test.com', 600);
    expect(mockRedis.del).not.toHaveBeenCalled();
  });
});

describe('generateOtp()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return a 6-digit string', async () => {
    const otp = await generateOtp('user@test.com');
    expect(otp).toMatch(/^\d{6}$/);
  });

  it('should persist the OTP via SET (no pipeline)', async () => {
    await generateOtp('user@test.com');
    expect(mockRedis.set).toHaveBeenCalledWith('otp:user@test.com', '123456', 'EX', 600);
  });

  it('should EXPIRE the attempts key (not DEL) so attempts decay with the OTP', async () => {
    await generateOtp('user@test.com');
    expect(mockRedis.expire).toHaveBeenCalledWith('otp_attempts:user@test.com', 600);
    expect(mockRedis.del).not.toHaveBeenCalled();
  });
});

describe('verifyOtp()', () => {
  beforeEach(() => { vi.clearAllMocks(); });

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
