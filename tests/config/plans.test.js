import { describe, it, expect } from 'vitest';
import { PLANS, ASSIGNABLE_PLANS, getDailyLimit } from '../../src/config/plans.js';

describe('PLANS', () => {
  it('should have free and premium plans', () => {
    expect(PLANS).toHaveProperty('free');
    expect(PLANS).toHaveProperty('premium');
  });

  it('free plan should have daily_requests', () => {
    expect(PLANS.free.daily_requests).toBeGreaterThan(0);
  });

  it('premium plan should have more daily_requests than free', () => {
    expect(PLANS.premium.daily_requests).toBeGreaterThan(PLANS.free.daily_requests);
  });
});

describe('ASSIGNABLE_PLANS', () => {
  it('should include free and premium', () => {
    expect(ASSIGNABLE_PLANS).toContain('free');
    expect(ASSIGNABLE_PLANS).toContain('premium');
  });
});

describe('getDailyLimit()', () => {
  it('should return free plan limit for free', () => {
    expect(getDailyLimit('free')).toBe(PLANS.free.daily_requests);
  });

  it('should return premium plan limit for premium', () => {
    expect(getDailyLimit('premium')).toBe(PLANS.premium.daily_requests);
  });

  it('should return free limit for unknown plan', () => {
    expect(getDailyLimit('unknown')).toBe(PLANS.free.daily_requests);
  });
});
