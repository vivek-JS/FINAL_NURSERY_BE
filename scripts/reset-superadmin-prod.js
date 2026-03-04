/**
 * Reset user 7588686453 on PROD back to DEALER (undo super admin).
 *
 * Usage: cd FINAL_NURSERY_BE && node scripts/reset-superadmin-prod.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/user.model.js';

dotenv.config();

const PHONE = 7588686453;
const PROD_URI = process.env.PROD_MONGO_URL;

if (!PROD_URI) {
  console.error('❌ PROD_MONGO_URL required in .env');
  process.exit(1);
}

async function main() {
  await mongoose.connect(PROD_URI);
  const user = await User.findOne({ phoneNumber: PHONE });
  if (!user) {
    console.log('User', PHONE, 'not found');
    await mongoose.disconnect();
    process.exit(1);
  }
  user.role = 'DEALER';
  user.jobTitle = 'DEALER';
  await user.save();
  console.log('Reset', PHONE, '(' + user.name + ') to DEALER');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
