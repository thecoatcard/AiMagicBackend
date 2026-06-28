import { authenticate } from '../auth/middleware.js';
import { getUser, getReferrals, giftPremium } from '../db/users.js';

export async function referralRoutes(fastify) {
  // Get current user's referral info
  fastify.get('/referrals/me', {
    preHandler: authenticate,
  }, async (request) => {
    let user = await getUser(request.user.email);
    if (!user) {
      throw fastify.httpErrors.notFound('User not found');
    }

    // Ensure referral code exists for legacy users
    if (!user.referral_code) {
      // We need getOrCreateUser to handle the heavy lifting or just do it here
      const { getOrCreateUser } = await import('../db/users.js');
      user = await getOrCreateUser(request.user.email);
    }

    const referrals = await getReferrals(request.user.email);
    const premiumReferralsCount = referrals.filter(r => r.plan === 'premium').length;

    return {
      referral_code: user.referral_code,
      referral_count: user.referral_count || 0,
      premium_referrals_count: premiumReferralsCount,
      gift_count: user.gift_count || 0,
    };
  });

  // Gift 1 month premium to another user (Premium users only)
  fastify.post('/referrals/gift', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
        },
      },
    },
  }, async (request) => {
    try {
      await giftPremium(request.user.email, request.body.email.toLowerCase());
      return { message: `Successfully gifted 1 month of Premium to ${request.body.email}` };
    } catch (err) {
      throw fastify.httpErrors.badRequest(err.message);
    }
  });

  // List all users referred by current user
  fastify.get('/referrals/list', {
    preHandler: authenticate,
  }, async (request) => {
    const referrals = await getReferrals(request.user.email);
    return {
      referrals: referrals.map(r => {
        const parts = r.email.split('@');
        const name = parts[0] || '';
        const domain = parts[1] || '';
        const maskedName = name.length > 2 
          ? name.slice(0, 2) + '***' 
          : name.slice(0, 1) + '***';
        return {
          email_masked: `${maskedName}@${domain}`,
          created_at: r.created_at,
          plan: r.plan,
        };
      }),
    };
  });
}
