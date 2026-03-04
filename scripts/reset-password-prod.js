/**
 * Reset password for a user on PROD. Usage:
 *   node scripts/reset-password-prod.js <phoneNumber> <newPassword>
 * Example: node scripts/reset-password-prod.js 7588686453 1234
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import User from '../models/user.model.js';

dotenv.config();

const phone = process.argv[2];
const newPassword = process.argv[3];
const PROD_URI = process.env.PROD_MONGO_URL;

if (!PROD_URI || !phone || !newPassword) {
  console.error('Usage: node scripts/reset-password-prod.js <phoneNumber> <newPassword>');
  process.exit(1);
}

const phoneNumber = Number(phone);
if (isNaN(phoneNumber)) {
  console.error('Invalid phone number');
  process.exit(1);
}

async function main() {
  await mongoose.connect(PROD_URI);
  const user = await User.findOne({ phoneNumber });
  if (!user) {
    console.error('User', phoneNumber, 'not found on prod');
    await mongoose.disconnect();
    process.exit(1);
  }
  user.password = await bcrypt.hash(newPassword, 10);
  user.isPasswordSet = false;
  await user.save();
  console.log('Password reset for', phoneNumber, '(' + user.name + '). New password:', newPassword);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
