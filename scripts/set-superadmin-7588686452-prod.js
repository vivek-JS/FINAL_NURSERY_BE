/**
 * Set user 7588686452 on PROD: jobTitle & role = SUPER_ADMIN, password = 1234.
 *
 * Usage: cd FINAL_NURSERY_BE && node scripts/set-superadmin-7588686452-prod.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import User from '../models/user.model.js';

dotenv.config();

const PHONE = 7588686452;
const PASSWORD = '1234';
const PROD_URI = process.env.PROD_MONGO_URL;

if (!PROD_URI) {
  console.error('❌ PROD_MONGO_URL required in .env');
  process.exit(1);
}

async function main() {
  await mongoose.connect(PROD_URI);
  const user = await User.findOne({ phoneNumber: PHONE });
  if (!user) {
    console.log('User', PHONE, 'not found on prod');
    await mongoose.disconnect();
    process.exit(1);
  }
  user.role = 'SUPER_ADMIN';
  user.jobTitle = 'SUPER_ADMIN';
  user.password = await bcrypt.hash(PASSWORD, 10);
  user.isPasswordSet = false;
  await user.save();
  console.log('Updated', PHONE, '(', user.name, ') on prod:');
  console.log('  role & jobTitle: SUPER_ADMIN');
  console.log('  password: ' + PASSWORD + ' (change on first login)');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
