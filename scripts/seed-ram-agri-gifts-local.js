/**
 * Seed sample Ram Agri gift products for local / stage dev.
 *
 * Usage:
 *   node scripts/seed-ram-agri-gifts-local.js
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import path from 'path';
import RamAgriInputsProduct from '../models/ramAgriInputsProduct.model.js';
import Unit from '../models/measurementUnit.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const SAMPLE_GIFTS = [
  {
    cropName: 'Farmer Welcome Kit',
    description: 'Starter gift hamper for new farmers',
    varieties: [{ name: 'Standard Kit', description: 'Basic welcome pack' }],
  },
  {
    cropName: 'Festival Gift Hamper',
    description: 'Seasonal promotional gift pack',
    varieties: [
      { name: 'Diwali Pack', description: 'Festival combo pack' },
      { name: 'New Year Pack', description: 'Year-end gift pack' },
    ],
  },
  {
    cropName: 'Dealer Loyalty Gift',
    description: 'Reward pack for top dealers',
    varieties: [{ name: 'Gold Pack', description: 'Premium loyalty gift' }],
  },
];

async function resolvePieceUnitId() {
  const piece =
    (await Unit.findOne({ abbreviation: 'Pc', isActive: true }).select('_id').lean()) ||
    (await Unit.findOne({ name: /^piece$/i, isActive: true }).select('_id').lean());
  if (!piece?._id) {
    throw new Error('Piece unit (Pc) not found. Seed units first.');
  }
  return piece._id;
}

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

  const primaryUnit = await resolvePieceUnitId();
  const createdBy = new mongoose.Types.ObjectId('6869ff079e52efe6184aec3a');
  let created = 0;
  let skipped = 0;

  for (const sample of SAMPLE_GIFTS) {
    const existing = await RamAgriInputsProduct.findOne({
      cropName: sample.cropName,
      productType: 'gift',
    }).lean();

    if (existing) {
      console.log(`Skip (exists): ${sample.cropName}`);
      skipped += 1;
      continue;
    }

    await RamAgriInputsProduct.create({
      productType: 'gift',
      cropName: sample.cropName,
      description: sample.description,
      isActive: true,
      createdBy,
      varieties: sample.varieties.map((v) => ({
        name: v.name,
        description: v.description || '',
        primaryUnit,
        conversionFactor: 1,
        isActive: true,
        rates: [],
      })),
    });

    console.log(`Created gift: ${sample.cropName} (${sample.varieties.length} varieties)`);
    created += 1;
  }

  await mongoose.disconnect();
  console.log(`Done. created=${created}, skipped=${skipped}`);
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
