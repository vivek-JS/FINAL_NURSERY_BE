/**
 * Sync role = jobTitle for ALL users in Sathe and Prod.
 * Where they differ, sets role = jobTitle (jobTitle is source of truth).
 * If jobTitle is empty, sets jobTitle = role (only when role is valid for jobTitle enum).
 * Skips users where role is FARMER/ADMIN and jobTitle empty (FARMER/ADMIN not in jobTitle enum).
 *
 * Usage:
 *   cd FINAL_NURSERY_BE && node scripts/sync-role-equals-jobtitle.js
 *
 * Requires in .env:
 *   MONGO_URL       - Sathe/Staging MongoDB URI
 *   PROD_MONGO_URL - Production MongoDB URI
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/user.model.js';

dotenv.config();

const JOBTITLE_ENUM = [
  'Manager', 'HR', 'SALES', 'PRIMARY', 'OFFICE_STAFF', 'DRIVER',
  'LABORATORY_MANAGER', 'DEALER', 'OFFICE_ADMIN', 'ACCOUNTANT',
  'DISPATCH_MANAGER', 'RAM_AGRI_SALES', 'RAM_AGRI_SALES_MANAGER',
  'AGRI_INPUT_DEALER', 'SUPER_ADMIN',
];

const SATHE_URI = process.env.MONGO_URL;
const PROD_URI = process.env.PROD_MONGO_URL;

if (!SATHE_URI) {
  console.error('❌ MONGO_URL (sathe) required in .env');
  process.exit(1);
}
if (!PROD_URI) {
  console.error('❌ PROD_MONGO_URL required in .env');
  process.exit(1);
}

async function syncUsers(uri, label) {
  await mongoose.connect(uri);
  const users = await User.find({}).lean();
  const mismatched = users.filter((u) => {
    const r = u.role || '';
    const j = u.jobTitle || '';
    return r !== j;
  });

  if (mismatched.length === 0) {
    console.log(`📋 ${label}: All ${users.length} users already have role === jobTitle\n`);
    await mongoose.disconnect();
    return;
  }

  console.log(`📋 ${label}: Updating ${mismatched.length} users (of ${users.length} total)\n`);
  let updated = 0;
  let skipped = 0;
  for (const u of mismatched) {
    const user = await User.findById(u._id);
    const before = { role: user.role, jobTitle: user.jobTitle || '(empty)' };
    // jobTitle as source; if empty, use role only if valid for jobTitle enum
    let target = user.jobTitle || user.role;
    if (!target || !JOBTITLE_ENUM.includes(target)) {
      skipped++;
      console.log(`   ⏭️  Skip ${user.name} (${user.phoneNumber}): role=${before.role}, jobTitle=${before.jobTitle} (target "${target}" not in jobTitle enum)`);
      continue;
    }
    user.role = target;
    user.jobTitle = target;
    await user.save();
    updated++;
    console.log(`   ${user.name} (${user.phoneNumber}): role ${before.role} → ${target}, jobTitle ${before.jobTitle} → ${target}`);
  }
  if (skipped) console.log(`\n   ⏭️  Skipped ${skipped} (FARMER/ADMIN with no jobTitle)`);
  console.log(`\n   ✅ ${label}: ${updated} users updated\n`);
  await mongoose.disconnect();
}

async function main() {
  try {
    console.log('\n🔄 Syncing role = jobTitle for all users\n');

    console.log('📦 Connecting to Sathe (staging)...');
    await syncUsers(SATHE_URI, 'Sathe');

    console.log('📦 Connecting to Prod...');
    await syncUsers(PROD_URI, 'Prod');

    console.log('✅ Done');
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

main();
