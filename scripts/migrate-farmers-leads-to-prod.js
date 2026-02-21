/**
 * Migrate Farmers and FarmerLeads from Staging to Production
 *
 * Usage:
 *   1. Set STAGING_MONGO_URL and PROD_MONGO_URL in .env (or pass as env vars)
 *   2. Run: node scripts/migrate-farmers-leads-to-prod.js
 *
 * Env vars:
 *   STAGING_MONGO_URL - Source (staging) MongoDB URI
 *   PROD_MONGO_URL   - Target (production) MongoDB URI
 *
 * If not set, uses MONGO_URL for staging and PROD_MONGO_URL for prod.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const STAGING_URI = process.env.STAGING_MONGO_URL || process.env.MONGO_URL;
const PROD_URI = process.env.PROD_MONGO_URL;

if (!STAGING_URI) {
  console.error('❌ STAGING_MONGO_URL or MONGO_URL required');
  process.exit(1);
}
if (!PROD_URI) {
  console.error('❌ PROD_MONGO_URL required');
  process.exit(1);
}

async function migrate() {
  let stagingConn;
  let prodConn;

  try {
    console.log('\n📦 Connecting to STAGING (source)...');
    stagingConn = await mongoose.createConnection(STAGING_URI).asPromise();
    console.log('✅ Staging connected');

    console.log('📦 Connecting to PRODUCTION (target)...');
    prodConn = await mongoose.createConnection(PROD_URI).asPromise();
    console.log('✅ Production connected\n');

    // Mongoose collection names: Farmer -> farmers, FarmerLead -> farmerleads
    const farmersCol = stagingConn.db.collection('farmers');
    const farmerLeadsCol = stagingConn.db.collection('farmerleads');

    const prodFarmersCol = prodConn.db.collection('farmers');
    const prodFarmerLeadsCol = prodConn.db.collection('farmerleads');

    // --- Migrate Farmers ---
    const farmers = await farmersCol.find({}).toArray();
    console.log(`📋 Found ${farmers.length} farmers in staging`);

    if (farmers.length > 0) {
      const farmerOps = farmers.map((doc) => ({
        replaceOne: {
          filter: { _id: doc._id },
          replacement: doc,
          upsert: true,
        },
      }));
      const farmerResult = await prodFarmersCol.bulkWrite(farmerOps, { ordered: false });
      console.log(`✅ Farmers: ${farmerResult.upsertedCount} inserted, ${farmerResult.modifiedCount} updated`);
    }

    // --- Migrate FarmerLeads ---
    const leads = await farmerLeadsCol.find({}).toArray();
    console.log(`📋 Found ${leads.length} farmer leads in staging`);

    if (leads.length > 0) {
      // FarmerLead has unique index on mobileNumber - upsert by mobile to avoid duplicate key errors
      // Use $set (excluding _id) to preserve prod _id when updating, avoiding broken references
      const leadOps = leads
        .filter((doc) => doc.mobileNumber)
        .map((doc) => {
          const { _id, ...rest } = doc;
          return {
            updateOne: {
              filter: { mobileNumber: doc.mobileNumber },
              update: { $set: rest, $setOnInsert: { _id } },
              upsert: true,
            },
          };
        });
      const leadResult = await prodFarmerLeadsCol.bulkWrite(leadOps, { ordered: false });
      console.log(`✅ FarmerLeads: ${leadResult.upsertedCount} inserted, ${leadResult.modifiedCount} updated`);
    }

    console.log('\n✅ Migration complete!\n');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    if (stagingConn) await stagingConn.close();
    if (prodConn) await prodConn.close();
    process.exit(0);
  }
}

migrate();
