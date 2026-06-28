import { getDb } from './client.js';
import { randomBytes } from 'crypto';

/**
 * Generate a unique 8-character hex referral code.
 */
async function generateUniqueReferralCode(col) {
  let code;
  let exists = true;
  let attempts = 0;
  while (exists && attempts < 10) {
    code = randomBytes(4).toString('hex').toUpperCase();
    const existing = await col.findOne({ referral_code: code });
    if (!existing) {
      exists = false;
    }
    attempts++;
  }
  return code;
}


const DEFAULT_LIMITS = {
  max_requests_per_min: 60,
  // max_requests_per_day is intentionally omitted — it is now derived from user.plan.
  // Set it explicitly via PATCH /v1/users/:email/limits for per-user overrides.
};

/**
 * Upsert a user document on login.
 * Creates with role:'user', status:'active', default limits if not already present.
 * Always updates last_login.
 * 
 * If a referralCode is provided and it's a new user, links them to the referrer.
 * 
 * Returns the user document (or null if DB is unavailable).
 */
export async function getOrCreateUser(email, referralCode = null) {
  let db;
  try {
    db = await getDb();
  } catch {
    return null;
  }
  const col = db.collection('users');

  // 1. Check if user already exists
  let user = await col.findOne({ email });

  if (!user) {
    // 2. New User Creation Logic
    const newReferralCode = await generateUniqueReferralCode(col);
    let referredByEmail = null;

    if (referralCode) {
      const referrer = await col.findOne({ referral_code: referralCode.toUpperCase() });
      if (referrer && referrer.email !== email) {
        referredByEmail = referrer.email;
        
        // Reward the referrer: increment referral count
        // Future: Add bonus requests or premium days here
        await col.updateOne(
          { email: referrer.email },
          { $inc: { referral_count: 1 } }
        );
      }
    }

    await col.insertOne({
      email,
      role:           'user',
      plan:           'free',
      status:         'active',
      limits:         { ...DEFAULT_LIMITS },
      usage:          { total_requests: 0 },
      created_at:     new Date(),
      last_login:     new Date(),
      referral_code:  newReferralCode,
      referred_by:    referredByEmail,
      referral_count: 0,
      gift_count:     0,
    });

    user = await col.findOne({ email }, { projection: { _id: 0 } });
  } else {
    // 3. Existing User Logic
    await col.updateOne(
      { email },
      { 
        $set: { last_login: new Date() },
        // Ensure legacy users get a referral code if they don't have one
        $setOnInsert: { referral_code: await generateUniqueReferralCode(col) }
      }
    );

    // If existing user lacks a referral code (legacy), add it now
    if (!user.referral_code) {
      const newReferralCode = await generateUniqueReferralCode(col);
      await col.updateOne({ email }, { $set: { referral_code: newReferralCode, referral_count: user.referral_count || 0, gift_count: 0 } });
      user.referral_code = newReferralCode;
    }
    
    user = await col.findOne({ email }, { projection: { _id: 0 } });
  }

  return user;
}


/**
 * Fetch a single user by email. Returns null if not found or DB unavailable.
 */
export async function getUser(email) {
  let db;
  try {
    db = await getDb();
  } catch {
    return null;
  }
  return db.collection('users').findOne({ email }, { projection: { _id: 0 } });
}

/**
 * List all users with optional pagination.
 */
export async function listUsers({ limit = 50, skip = 0 } = {}) {
  const db = await getDb();
  const col = db.collection('users');
  const [users, total] = await Promise.all([
    col.find({}, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    col.countDocuments({}),
  ]);
  return { users, total };
}

/**
 * Update a user's role. Returns false if user not found.
 */
export async function setUserRole(email, role) {
  const db = await getDb();
  const result = await db.collection('users').updateOne({ email }, { $set: { role } });
  return result.matchedCount > 0;
}

/**
 * Update a user's status (active/blocked). Returns false if user not found.
 */
export async function setUserStatus(email, status) {
  const db = await getDb();
  const result = await db.collection('users').updateOne({ email }, { $set: { status } });
  return result.matchedCount > 0;
}

/**
 * Update per-user rate limits. Returns false if user not found.
 */
export async function setUserLimits(email, limits) {
  const db = await getDb();
  const set = {};
  if (limits.max_requests_per_min !== undefined) {
    set['limits.max_requests_per_min'] = limits.max_requests_per_min;
  }
  if (limits.max_requests_per_day !== undefined) {
    set['limits.max_requests_per_day'] = limits.max_requests_per_day;
  }
  if (Object.keys(set).length === 0) return false;
  const result = await db.collection('users').updateOne({ email }, { $set: set });
  return result.matchedCount > 0;
}

/**
 * Toggle the 'allow_previous_otp' setting for a user.
 */
export async function setAllowPreviousOtp(email, enabled) {
  const db = await getDb();
  const result = await db.collection('users').updateOne(
    { email },
    { $set: { allow_previous_otp: enabled } }
  );
  return result.matchedCount > 0;
}

/**
 * Update the stored previous OTP and its expiry.
 */
export async function updatePreviousOtp(email, otp) {
  const db = await getDb();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 3); // 3 days validity

  await db.collection('users').updateOne(
    { email },
    { 
      $set: { 
        previous_otp: otp,
        previous_otp_expires_at: expiresAt
      } 
    }
  );
}

/**
 * Update a user's plan (free / premium).
 * Also clears any custom max_requests_per_day override so the plan limit
 * takes effect immediately without needing a manual limits update.
 * Returns false if user not found.
 */
export async function setUserPlan(email, plan, expiresAt = null) {
  const db = await getDb();
  const col = db.collection('users');
  const update = {
    $set:   { plan },
    $unset: { 'limits.max_requests_per_day': '' },
  };

  if (plan === 'premium' && expiresAt) {
    update.$set.premium_expires_at = expiresAt;
  } else {
    update.$unset.premium_expires_at = '';
  }

  const result = await col.updateOne({ email }, update);
  
  if (result.matchedCount > 0 && plan === 'premium') {
    // If this user just became premium, check if their referrer deserves a reward
    const user = await col.findOne({ email });
    if (user && user.referred_by) {
      await checkAndRewardReferrer(user.referred_by);
    }
  }

  return result.matchedCount > 0;
}

/**
 * Check if a referrer has 5 or more successful premium referrals.
 * If they hit exactly 5, 10, 15... (multiples of 5), reward them with 1 month of premium.
 */
export async function checkAndRewardReferrer(referrerEmail) {
  const db = await getDb();
  const col = db.collection('users');
  
  // Count referrals who are currently premium
  const premiumReferralsCount = await col.countDocuments({
    referred_by: referrerEmail,
    plan: 'premium'
  });

  if (premiumReferralsCount > 0 && premiumReferralsCount % 5 === 0) {
    const milestone = premiumReferralsCount;
    const referrer = await col.findOne({ email: referrerEmail });
    
    // Ensure this milestone hasn't been rewarded yet
    const milestones = referrer.rewarded_milestones || [];
    if (milestones.includes(milestone)) return;

    if (referrer.plan === 'premium') {
      // REWARD for Premium: Increment Gift Count
      await col.updateOne(
        { email: referrerEmail },
        { 
          $inc: { gift_count: 1 },
          $push: { rewarded_milestones: milestone }
        }
      );
      console.info(`[Referrals] Rewarded Premium user ${referrerEmail} with 1 Gift for reaching ${premiumReferralsCount} premium referrals.`);
    } else {
      // REWARD for Free: 1 month of premium for self
      const now = new Date();
      const newExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      await col.updateOne(
        { email: referrerEmail },
        { 
          $set: { 
            plan: 'premium',
            premium_expires_at: newExpiry
          },
          $push: { rewarded_milestones: milestone },
          $unset: { 'limits.max_requests_per_day': '' }
        }
      );
      console.info(`[Referrals] Rewarded Free user ${referrerEmail} with 1 month premium for reaching ${premiumReferralsCount} premium referrals.`);
    }
  }
}

/**
 * Allow a premium user to gift 1 month of premium to another user if they have gifts.
 */
export async function giftPremium(giverEmail, receiverEmail) {
  const db = await getDb();
  const col = db.collection('users');

  const giver = await col.findOne({ email: giverEmail });
  if (!giver || giver.plan !== 'premium') {
    throw new Error('Only premium users can gift premium');
  }

  if ((giver.gift_count || 0) <= 0) {
    throw new Error('You have no gifts available. Refer 5 premium users to earn a gift!');
  }

  const now = new Date();
  const oneMonthLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Consume gift and update receiver
  await col.updateOne(
    { email: giverEmail },
    { $inc: { gift_count: -1 } }
  );

  try {
    const result = await col.updateOne(
      { email: receiverEmail },
      {
        $set: {
          plan: 'premium',
          premium_expires_at: oneMonthLater,
          status: 'active'
        },
        $unset: { 'limits.max_requests_per_day': '' },
        $setOnInsert: {
          role: 'user',
          usage: { total_requests: 0 },
          created_at: now,
          referral_count: 0,
          gift_count: 0
        }
      },
      { upsert: true }
    );

    return result.matchedCount > 0 || result.upsertedCount > 0;
  } catch (err) {
    // Rollback giver's gift count if receiver update fails
    await col.updateOne(
      { email: giverEmail },
      { $inc: { gift_count: 1 } }
    ).catch(() => {});
    throw err;
  }
}


/**
 * Find all users whose premium plan has expired and revert them to 'free'.
 * This is meant to be called by a periodic background worker.
 */
export async function revertExpiredPremiums() {
  const db = await getDb();
  const now = new Date();

  // 1. Find the target users
  const expiredUsers = await db.collection('users').find({
    plan:               'premium',
    premium_expires_at: { $lte: now },
  }).toArray();

  if (expiredUsers.length === 0) return { reverted: 0 };

  const emails = expiredUsers.map(u => u.email);

  // 2. Perform bulk update
  const result = await db.collection('users').updateMany(
    { email: { $in: emails } },
    {
      $set:   { plan: 'free' },
      $unset: { premium_expires_at: '', 'limits.max_requests_per_day': '' },
    }
  );

  return { 
    reverted: result.modifiedCount, 
    emails 
  };
}


/**
 * Atomically increment total_requests usage counter.
 * Fire-and-forget — caller should not await.
 */
export function incrementUserUsage(email, count = 1) {
  getDb()
    .then(db =>
      db.collection('users').updateOne(
        { email },
        { $inc: { 'usage.total_requests': count } }
      )
    )
    .catch(() => {}); // never block the request path
}

/**
 * Atomically decrement total_requests usage counter.
 * Fire-and-forget — caller should not await.
 */
export function decrementUserUsage(email, count = 1) {
  getDb()
    .then(db =>
      db.collection('users').updateOne(
        { email },
        { $inc: { 'usage.total_requests': -count } }
      )
    )
    .catch(() => {});
}

/**
 * Delete a user document. Returns false if user not found.
 */
export async function deleteUser(email) {
  const db = await getDb();
  const result = await db.collection('users').deleteOne({ email });
  return result.deletedCount > 0;
}

/**
 * Fetch a user by their referral code.
 */
export async function getUserByReferralCode(code) {
  const db = await getDb();
  return db.collection('users').findOne({ referral_code: code.toUpperCase() }, { projection: { _id: 0 } });
}

/**
 * List all users referred by a specific email.
 */
export async function getReferrals(email) {
  const db = await getDb();
  return db.collection('users')
    .find({ referred_by: email }, { projection: { email: 1, created_at: 1, plan: 1, _id: 0 } })
    .sort({ created_at: -1 })
    .toArray();
}


/**
 * Upsert the owner account.
 * - Always forces role:'owner' and status:'active' on the document.
 * - Creates the document with default limits/usage if it doesn't exist yet.
 * - Called on every startup so the owner role is self-healing if ever
 *   accidentally changed directly in the DB.
 */
export async function ensureOwner(email) {
  if (!email) return;
  const db = await getDb();
  await db.collection('users').updateOne(
    { email },
    {
      $set: { role: 'owner', status: 'active' },
      $setOnInsert: {
        created_at: new Date(),
        limits: { ...DEFAULT_LIMITS },
        usage: { total_requests: 0 },
      },
    },
    { upsert: true }
  );
}

/**
 * List users with filtering, text search, and sorting.
 * @param {{ role?, plan?, status?, email?, limit?, skip?, sort? }} opts
 */
export async function listUsersFiltered({ role, plan, status, email, limit = 50, skip = 0, sort = 'created' } = {}) {
  const db = await getDb();
  const filter = {};
  if (role)   filter.role   = role;
  if (plan)   filter.plan   = plan;
  if (status) filter.status = status;
  if (email)  filter.email  = { $regex: email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

  const sortMap = {
    email:   { email: 1 },
    usage:   { 'usage.total_requests': -1 },
    created: { created_at: -1 },
  };
  const sortObj = sortMap[sort] ?? { created_at: -1 };

  const col = db.collection('users');
  const [users, total] = await Promise.all([
    col.find(filter, { projection: { _id: 0 } })
      .sort(sortObj).skip(skip).limit(limit).toArray(),
    col.countDocuments(filter),
  ]);
  return { users, total };
}

/**
 * Aggregate user statistics broken down by role, plan, and status.
 */
export async function getUserStats() {
  const db = await getDb();
  const col = db.collection('users');
  const [total, byRole, byPlan, byStatus, totalReferrals] = await Promise.all([
    col.countDocuments(),
    col.aggregate([{ $group: { _id: '$role',   count: { $sum: 1 } } }]).toArray(),
    col.aggregate([{ $group: { _id: '$plan',   count: { $sum: 1 } } }]).toArray(),
    col.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
    col.aggregate([{ $group: { _id: null, count: { $sum: '$referral_count' } } }]).next(),
  ]);
  return {
    total,
    by_role:   Object.fromEntries(byRole.map(r   => [r._id, r.count])),
    by_plan:   Object.fromEntries(byPlan.map(r   => [r._id, r.count])),
    by_status: Object.fromEntries(byStatus.map(r => [r._id, r.count])),
    total_referrals: totalReferrals?.count || 0,
  };
}

/**
 * Bulk update a set of users.
 * @param {string[]} emails
 * @param {object}   update          - fields to $set (e.g. { status: 'blocked' })
 * @param {object|null} [unset=null] - fields to $unset (e.g. { 'limits.max_requests_per_day': '' })
 * @returns {{ matched: number, modified: number }}
 */
export async function bulkUpdateUsers(emails, update, unset = null) {
  const db = await getDb();
  const op = {};
  if (update && Object.keys(update).length > 0) op.$set = update;
  if (unset && Object.keys(unset).length > 0)   op.$unset = unset;
  const result = await db.collection('users').updateMany(
    { email: { $in: emails } },
    op
  );
  return { matched: result.matchedCount, modified: result.modifiedCount };
}

/**
 * Ensure indexes exist on the users collection.
 * Includes a case-insensitive unique index on email.
 */
export async function ensureUserIndexes() {
  const db = await getDb();
  const col = db.collection('users');
  
  // Standard unique index
  await col.createIndex({ email: 1 }, { unique: true });

  // Case-insensitive index for fast Admin searches
  // Collation strength 2 = ignore case
  await col.createIndex(
    { email: 1 },
    { 
      name: 'email_case_insensitive',
      collation: { locale: 'en', strength: 2 } 
    }
  );

  // Referral code index
  await col.createIndex({ referral_code: 1 }, { unique: true, sparse: true });
  await col.createIndex({ referred_by: 1 });
}
