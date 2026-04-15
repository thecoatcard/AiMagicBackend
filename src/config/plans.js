/**
 * Central plan configuration — the single source of truth for plan-based limits.
 * Change limits here only; never hard-code them in middleware or route logic.
 */
export const PLANS = {
  free:    { label: 'Free',    daily_requests: 5   },
  premium: { label: 'Premium', daily_requests: 500 },
};

/** Plans that can be assigned to users via the API. */
export const ASSIGNABLE_PLANS = Object.keys(PLANS); // ['free', 'premium']

/**
 * Return the daily request limit for a given plan.
 * Returns Infinity for admin/owner roles — they bypass limits entirely.
 *
 * @param {string} plan  - 'free' | 'premium'
 * @returns {number}
 */
export function getDailyLimit(plan) {
  return PLANS[plan]?.daily_requests ?? PLANS.free.daily_requests;
}
