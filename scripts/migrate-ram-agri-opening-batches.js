/**
 * One-time migration: create OPENING_BALANCE batches for existing variety stock.
 * Usage:
 *   node scripts/migrate-ram-agri-opening-batches.js          # MONGO_URL / MONGODB_URI
 *   node scripts/migrate-ram-agri-opening-batches.js --prod     # PROD_MONGO_URL
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import RamAgriInputsProduct from '../models/ramAgriInputsProduct.model.js';
import RamAgriBatch from '../models/ramAgriBatch.model.js';
import '../models/measurementUnit.model.js';
import { createInboundBatch } from '../services/ramAgriBatchInventory.service.js';

dotenv.config();

const useProd = process.argv.includes('--prod') || process.argv.includes('--prod-db');

function resolveMongoUri() {
  if (useProd) {
    return process.env.PROD_MONGO_URL || process.env.PROD_MONGODB_URI;
  }
  return (
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URL ||
    process.env.STAGE_MONGO_URL
  );
}

async function resolveMigrationUserId(crops) {
  if (process.env.MIGRATION_USER_ID) return process.env.MIGRATION_USER_ID;
  for (const crop of crops) {
    if (crop.createdBy) return crop.createdBy;
  }
  const { default: User } = await import('../models/user.model.js');
  const admin = await User.findOne({
    $or: [{ role: 'SUPER_ADMIN' }, { jobTitle: 'SUPER_ADMIN' }],
  })
    .select('_id')
    .lean();
  return admin?._id || null;
}

async function main() {
  const uri = resolveMongoUri();
  if (!uri) {
    console.error(
      useProd
        ? 'PROD_MONGO_URL required (pass --prod after setting it in .env)'
        : 'MONGO_URL / MONGODB_URI required'
    );
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(`Connected to MongoDB (${useProd ? 'production' : 'non-prod'})`);

  const crops = await RamAgriInputsProduct.find({}).populate('varieties.primaryUnit');
  const migrationUserId = await resolveMigrationUserId(crops);
  if (!migrationUserId) {
    console.error('No migration user found. Set MIGRATION_USER_ID in .env');
    process.exit(1);
  }

  let created = 0;
  let skipped = 0;

  for (const crop of crops) {
    for (const variety of crop.varieties || []) {
      const stock = Number(variety.currentStock) || 0;
      if (stock <= 0) {
        skipped++;
        continue;
      }

      const unitId = variety.primaryUnit?._id || variety.primaryUnit;
      if (!unitId) {
        console.warn(`Skip (no primary unit): ${crop.cropName} / ${variety.name}`);
        skipped++;
        continue;
      }

      const existing = await RamAgriBatch.countDocuments({
        ramAgriCropId: crop._id,
        ramAgriVarietyId: variety._id,
      });
      if (existing > 0) {
        skipped++;
        continue;
      }

      const price =
        Number(variety.averagePrice || variety.purchasePrice || variety.defaultRate) || 0;
      const userId = migrationUserId;

      await createInboundBatch({
        cropId: crop._id,
        varietyId: variety._id,
        quantityPrimary: stock,
        purchasePrice: price,
        unitId,
        source: 'OPENING_BALANCE',
        referenceType: 'Migration',
        referenceNumber: 'migrate-ram-agri-opening-batches',
        userId,
        cropName: crop.cropName,
        varietyName: variety.name,
      });
      created++;
      console.log(`Created opening batch: ${crop.cropName} / ${variety.name} qty=${stock}`);
    }
  }

  console.log(`Done. Created=${created}, Skipped=${skipped}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
