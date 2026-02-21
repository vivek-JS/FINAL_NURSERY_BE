/**
 * Revert Farmers and FarmerLeads migration (remove migrated data from Production)
 *
 * Usage: node scripts/revert-farmers-leads-migration.js
 *
 * What it does:
 *   - Deletes farmers from prod where _id matches staging farmers
 *   - Deletes farmerleads from prod where mobileNumber matches staging leads
 *     (We updated 117 leads with staging data; original prod data cannot be restored)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const STAGING_URI = process.env.STAGING_MONGO_URL || process.env.MONGO_URL;
const PROD_URI = process.env.PROD_MONGO_URL;

if (!STAGING_URI || !PROD_URI) {
  console.error('❌ MONGO_URL and PROD_MONGO_URL required');
  process.exit(1);
}

async function revert() {
  let stagingConn;
  let prodConn;

  try {
    console.log('\n📦 Connecting to STAGING (source)...');
    stagingConn = await mongoose.createConnection(STAGING_URI).asPromise();
    console.log('✅ Staging connected');

    console.log('📦 Connecting to PRODUCTION (target)...');
    prodConn = await mongoose.createConnection(PROD_URI).asPromise();
    console.log('✅ Production connected\n');

    const farmersCol = stagingConn.db.collection('farmers');
    const farmerLeadsCol = stagingConn.db.collection('farmerleads');
    const prodFarmersCol = prodConn.db.collection('farmers');
    const prodFarmerLeadsCol = prodConn.db.collection('farmerleads');

    // --- Revert Farmers: delete from prod where _id in staging ---
    const stagingFarmerIds = await farmersCol.find({}, { projection: { _id: 1 } }).toArray();
    const ids = stagingFarmerIds.map((d) => d._id);
    console.log(`📋 Found ${ids.length} farmers in staging to remove from prod`);

    if (ids.length > 0) {
      const farmerResult = await prodFarmersCol.deleteMany({ _id: { $in: ids } });
      console.log(`✅ Farmers: ${farmerResult.deletedCount} deleted from prod`);
    }

    // --- Revert FarmerLeads: delete from prod where mobileNumber in staging ---
    const stagingMobiles = await farmerLeadsCol
      .find({ mobileNumber: { $exists: true, $ne: '' } }, { projection: { mobileNumber: 1 } })
      .toArray();
    const mobiles = [...new Set(stagingMobiles.map((d) => d.mobileNumber))];
    console.log(`📋 Found ${mobiles.length} unique mobile numbers in staging leads`);

    if (mobiles.length > 0) {
      const leadResult = await prodFarmerLeadsCol.deleteMany({ mobileNumber: { $in: mobiles } });
      console.log(`✅ FarmerLeads: ${leadResult.deletedCount} deleted from prod`);
    }

    console.log('\n✅ Revert complete!\n');
  } catch (err) {
    console.error('❌ Revert failed:', err);
    process.exit(1);
  } finally {
    if (stagingConn) await stagingConn.close();
    if (prodConn) await prodConn.close();
    process.exit(0);
  }
}

revert();
