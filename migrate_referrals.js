import { getDb } from './src/db/client.js';
import { randomBytes } from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

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

async function migrate() {
  const db = await getDb();
  const col = db.collection('users');
  
  // 1. Fix users without referral codes
  const usersWithoutCode = await col.find({ referral_code: { $exists: false } }).toArray();
  console.log(`Found ${usersWithoutCode.length} users without referral codes.`);
  for (const user of usersWithoutCode) {
    const code = await generateUniqueReferralCode(col);
    await col.updateOne({ _id: user._id }, { $set: { referral_code: code, referral_count: user.referral_count || 0, gift_count: 0 } });
    console.log(`Assigned code ${code} to ${user.email}`);
  }

  // 2. Fix users with codes but missing gift_count
  const usersWithoutGiftCount = await col.find({ gift_count: { $exists: false } }).toArray();
  console.log(`Found ${usersWithoutGiftCount.length} users without gift_count.`);
  for (const user of usersWithoutGiftCount) {
    await col.updateOne({ _id: user._id }, { $set: { gift_count: 0 } });
  }
  
  console.log('Migration complete.');
  process.exit(0);
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
