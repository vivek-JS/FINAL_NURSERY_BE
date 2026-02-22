/**
 * Sync role and jobTitle to SUPER_ADMIN for user 7588686452 in both Sathe (staging) and Prod
 *
 * Usage:
 *   cd FINAL_NURSERY_BE && node scripts/sync-superadmin-role-jobtitle.js
 *
 * Requires in .env:
 *   MONGO_URL       - Sathe/Staging MongoDB URI
 *   PROD_MONGO_URL - Production MongoDB URI
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/user.model.js';

dotenv.config();

const PHONE = 7588686452;
const TARGET_ROLE = 'SUPER_ADMIN';
const TARGET_JOBTITLE = 'SUPER_ADMIN';

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

async function updateUser(uri, label) {
  await mongoose.connect(uri);
  const user = await User.findOne({ phoneNumber: PHONE });
  if (!user) {
    console.log(`   ⚠️  User ${PHONE} not found in ${label}\n`);
    await mongoose.disconnect();
    return false;
  }
  const before = { role: user.role, jobTitle: user.jobTitle || '(not set)' };
  user.role = TARGET_ROLE;
  user.jobTitle = TARGET_JOBTITLE;
  await user.save();
  console.log(`📋 ${label}:`);
  console.log(`   Name: ${user.name}`);
  console.log(`   Before: role=${before.role}, jobTitle=${before.jobTitle}`);
  console.log(`   After:  role=${user.role}, jobTitle=${user.jobTitle}`);
  console.log('   ✅ Updated\n');
  await mongoose.disconnect();
  return true;
}

async function main() {
  try {
    console.log('\n🔄 Syncing user 7588686452 → role & jobTitle = SUPER_ADMIN\n');

    console.log('📦 Connecting to Sathe (staging)...');
    const satheOk = await updateUser(SATHE_URI, 'Sathe');
    if (!satheOk) console.log('   (skipped - user not found)\n');

    console.log('📦 Connecting to Prod...');
    const prodOk = await updateUser(PROD_URI, 'Prod');
    if (!prodOk) console.log('   (skipped - user not found)\n');

    if (!satheOk && !prodOk) {
      console.log('❌ User not found in either database');
      process.exit(1);
    }

    console.log('✅ Done');
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

main();
