/**
 * Copy Old Sales Data from Staging to Production
 *
 * Usage:
 *   1. Set STAGING_MONGO_URL (or MONGO_URL) and PROD_MONGO_URL in .env
 *   2. Run: node scripts/copy-old-sales-stage-to-prod.js
 *
 * Env vars:
 *   STAGING_MONGO_URL - Source (staging) MongoDB URI
 *   PROD_MONGO_URL   - Target (production) MongoDB URI
 *
 * If not set, uses MONGO_URL for staging and PROD_MONGO_URL for prod.
 */

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const STAGING_URI = process.env.STAGING_MONGO_URL || process.env.MONGO_URL;
const PROD_URI = process.env.PROD_MONGO_URL;

if (!STAGING_URI) {
  console.error("❌ STAGING_MONGO_URL or MONGO_URL required");
  process.exit(1);
}
if (!PROD_URI) {
  console.error("❌ PROD_MONGO_URL required");
  process.exit(1);
}

const BATCH_SIZE = 1000;

async function copyCollection(stagingConn, prodConn, collectionName) {
  const stagingCol = stagingConn.db.collection(collectionName);
  const prodCol = prodConn.db.collection(collectionName);

  const count = await stagingCol.countDocuments();
  console.log(`📋 Found ${count} documents in ${collectionName}`);

  if (count === 0) return { inserted: 0, modified: 0 };

  let inserted = 0;
  let modified = 0;
  let cursor = stagingCol.find({});
  let batch = [];
  let processed = 0;

  while (await cursor.hasNext()) {
    batch.push(await cursor.next());
    if (batch.length >= BATCH_SIZE) {
      const ops = batch.map((doc) => ({
        replaceOne: {
          filter: { _id: doc._id },
          replacement: doc,
          upsert: true,
        },
      }));
      const result = await prodCol.bulkWrite(ops, { ordered: false });
      inserted += result.upsertedCount || 0;
      modified += result.modifiedCount || 0;
      processed += batch.length;
      console.log(`   ... ${processed}/${count}`);
      batch = [];
    }
  }

  if (batch.length > 0) {
    const ops = batch.map((doc) => ({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true,
      },
    }));
    const result = await prodCol.bulkWrite(ops, { ordered: false });
    inserted += result.upsertedCount || 0;
    modified += result.modifiedCount || 0;
  }

  return { inserted, modified };
}

async function migrate() {
  let stagingConn;
  let prodConn;

  try {
    console.log("\n📦 Connecting to STAGING (source)...");
    stagingConn = await mongoose.createConnection(STAGING_URI).asPromise();
    console.log("✅ Staging connected");

    console.log("📦 Connecting to PRODUCTION (target)...");
    prodConn = await mongoose.createConnection(PROD_URI).asPromise();
    console.log("✅ Production connected\n");

    // Copy old_sales_data
    console.log("📤 Copying old_sales_data...");
    const dataResult = await copyCollection(stagingConn, prodConn, "old_sales_data");
    console.log(`✅ old_sales_data: ${dataResult.inserted} inserted, ${dataResult.modified} updated\n`);

    // Copy old_sales_change_logs
    console.log("📤 Copying old_sales_change_logs...");
    const logResult = await copyCollection(stagingConn, prodConn, "old_sales_change_logs");
    console.log(`✅ old_sales_change_logs: ${logResult.inserted} inserted, ${logResult.modified} updated\n`);

    console.log("✅ Migration complete!\n");
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    if (stagingConn) await stagingConn.close();
    if (prodConn) await prodConn.close();
    process.exit(0);
  }
}

migrate();
