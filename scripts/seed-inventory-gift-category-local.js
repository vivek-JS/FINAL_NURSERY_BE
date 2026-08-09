/**
 * Seed "gift" inventory category + sample normal products (not Ram Agri inputs).
 *
 * Usage:
 *   node scripts/seed-inventory-gift-category-local.js
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import path from 'path';
import Category from '../models/category.model.js';
import Product from '../models/product.model.js';
import MeasurementUnit from '../models/measurementUnit.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const GIFT_CATEGORY = {
  name: 'gift',
  displayName: 'Gifts',
  description: 'Promotional / gift inventory products',
};

const SAMPLE_PRODUCTS = [
  { code: 'GIFT-WELCOME-01', name: 'Farmer Welcome Kit', description: 'Starter gift pack' },
  { code: 'GIFT-FEST-01', name: 'Festival Gift Hamper', description: 'Seasonal gift pack' },
  { code: 'GIFT-DEALER-01', name: 'Dealer Loyalty Gift', description: 'Dealer reward pack' },
];

async function main() {
  const mongoUrl =
    process.env.MONGO_URL ||
    process.env.STAGE_MONGO_URL ||
    process.env.MONGODB_URI;

  if (!mongoUrl) {
    console.error('Missing MONGO_URL / STAGE_MONGO_URL / MONGODB_URI in .env');
    process.exit(1);
  }

  await mongoose.connect(mongoUrl);
  console.log('Connected to MongoDB');

  const createdBy = new mongoose.Types.ObjectId('6869ff079e52efe6184aec3a');

  let category = await Category.findOne({ name: GIFT_CATEGORY.name }).lean();
  if (!category) {
    category = await Category.create({
      ...GIFT_CATEGORY,
      isActive: true,
      createdBy,
    });
    console.log('Created category: gift (Gifts)');
  } else {
    console.log('Category already exists: gift');
  }

  const pieceUnit =
    (await MeasurementUnit.findOne({ abbreviation: 'Pc', isActive: true }).select('_id').lean()) ||
    (await MeasurementUnit.findOne({ name: /^piece$/i, isActive: true }).select('_id').lean());

  if (!pieceUnit?._id) {
    throw new Error('Piece unit (Pc) not found');
  }

  let productsCreated = 0;
  let productsSkipped = 0;

  for (const sample of SAMPLE_PRODUCTS) {
    const exists = await Product.findOne({ code: sample.code }).lean();
    if (exists) {
      console.log(`Skip product (exists): ${sample.code}`);
      productsSkipped += 1;
      continue;
    }

    await Product.create({
      code: sample.code,
      name: sample.name,
      description: sample.description,
      category: GIFT_CATEGORY.name,
      purpose: 'sales',
      primaryUnit: pieceUnit._id,
      conversionFactor: 1,
      minStockLevel: 0,
      currentStock: 0,
      isActive: true,
      isRamAgriSales: false,
      createdBy,
    });
    console.log(`Created product: ${sample.code} — ${sample.name}`);
    productsCreated += 1;
  }

  await mongoose.disconnect();
  console.log(`Done. category=gift, products created=${productsCreated}, skipped=${productsSkipped}`);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
