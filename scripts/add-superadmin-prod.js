/**
 * Add or update a super admin user on PROD with login (phone) 7588686453.
 * - If user exists: sets role and jobTitle to SUPER_ADMIN.
 * - If user does not exist: creates user with default password "1234".
 *
 * Usage:
 *   cd FINAL_NURSERY_BE && node scripts/add-superadmin-prod.js
 *
 * Requires in .env:
 *   PROD_MONGO_URL - Production MongoDB URI
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import User from '../models/user.model.js';

dotenv.config();

const PHONE = 7588686453;
const TARGET_ROLE = 'SUPER_ADMIN';
const TARGET_JOBTITLE = 'SUPER_ADMIN';
const DEFAULT_PASSWORD = '1234';

const PROD_URI = process.env.PROD_MONGO_URL;

if (!PROD_URI) {
  console.error('❌ PROD_MONGO_URL required in .env');
  process.exit(1);
}

async function main() {
  try {
    console.log('\n🔄 Add/update super admin on PROD (login:', PHONE, ')\n');

    await mongoose.connect(PROD_URI);
    console.log('📦 Connected to Prod\n');

    let user = await User.findOne({ phoneNumber: PHONE });

    if (user) {
      const before = { role: user.role, jobTitle: user.jobTitle || '(not set)' };
      user.role = TARGET_ROLE;
      user.jobTitle = TARGET_JOBTITLE;
      await user.save();
      console.log('📋 Prod: user already existed – updated to SUPER_ADMIN');
      console.log('   Name:', user.name);
      console.log('   Phone:', user.phoneNumber);
      console.log('   Before: role=' + before.role + ', jobTitle=' + before.jobTitle);
      console.log('   After:  role=' + user.role + ', jobTitle=' + user.jobTitle);
      console.log('   ✅ Done\n');
    } else {
      const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);
      user = await User.create({
        name: 'Super Admin',
        phoneNumber: PHONE,
        password: hashedPassword,
        isPasswordSet: false,
        jobTitle: TARGET_JOBTITLE,
        role: TARGET_ROLE,
        isDisabled: false,
      });
      console.log('📋 Prod: created new SUPER_ADMIN user');
      console.log('   Name:', user.name);
      console.log('   Phone:', user.phoneNumber);
      console.log('   role:', user.role, ', jobTitle:', user.jobTitle);
      console.log('   Default password: ' + DEFAULT_PASSWORD + ' (change on first login)');
      console.log('   ✅ Done\n');
    }

    await mongoose.disconnect();
    console.log('✅ Complete');
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

main();
