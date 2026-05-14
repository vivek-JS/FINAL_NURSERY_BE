/**
 * One-time migration: unset displayOrder (set to null/$unset) on all
 * RamAgriInputsProduct documents AND all their embedded varieties.
 *
 * Run on prod:
 *   node scripts/clear-agri-input-display-order.js --prod
 * Run on stage (default):
 *   node scripts/clear-agri-input-display-order.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const isProd = process.argv.includes('--prod');
const mongoUrl = isProd
  ? process.env.PROD_MONGO_URL
  : (process.env.STAGE_MONGO_URL || process.env.MONGO_URL);

if (!mongoUrl) {
  console.error('No Mongo URL found. Check .env PROD_MONGO_URL / STAGE_MONGO_URL');
  process.exit(1);
}

console.log(`Connecting to ${isProd ? 'PROD' : 'STAGE'} DB...`);
await mongoose.connect(mongoUrl);
console.log('Connected.');

const db = mongoose.connection.db;
const col = db.collection('ramagriinputsproducts');

// 1. Unset displayOrder on all top-level crop documents
const cropResult = await col.updateMany(
  {},
  { $unset: { displayOrder: '' } }
);
console.log(`Crops updated: ${cropResult.modifiedCount}`);

// 2. Unset displayOrder on every embedded variety
//    Use $[] to touch all array elements
const varietyResult = await col.updateMany(
  { 'varieties.0': { $exists: true } },
  { $unset: { 'varieties.$[].displayOrder': '' } }
);
console.log(`Crops with varieties updated: ${varietyResult.modifiedCount}`);

await mongoose.disconnect();
console.log('Done. All displayOrder fields cleared — items will now sort to end by default.');
