/**
 * Remove a single DealerLedgerEntry (native collection — bypasses Mongoose immutability hooks).
 * Loads env from FINAL_NURSERY_BE/.env; use --prod for PROD_MONGO_URL.
 *
 * Usage (from FINAL_NURSERY_BE):
 *   node scripts/delete-dealer-ledger-entry.js --prod --id=<mongoId>
 *   node scripts/delete-dealer-ledger-entry.js --prod --id=<mongoId> --execute
 *   node scripts/delete-dealer-ledger-entry.js --prod --id=<mongoId> --search   # find _id in any collection
 *
 * Without --execute: only prints the document (dry run).
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import "../models/dealerLedgerEntry.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

function parseArgs(argv) {
  const out = { prod: false, id: null, execute: false, search: false };
  for (const a of argv) {
    if (a === "--prod") out.prod = true;
    else if (a === "--execute") out.execute = true;
    else if (a === "--search") out.search = true;
    else if (a.startsWith("--id=")) out.id = a.slice(5);
  }
  return out;
}

async function searchAllCollections(db, _id) {
  const cols = (await db.listCollections().toArray()).map((c) => c.name);
  const hits = [];
  for (const n of cols) {
    try {
      const doc = await db.collection(n).findOne({ _id });
      if (doc) hits.push({ collection: n, refType: doc.refType, keys: Object.keys(doc).slice(0, 12) });
    } catch {
      /* view or unsupported */
    }
  }
  return hits;
}

async function main() {
  const { prod, id: entryId, execute, search } = parseArgs(process.argv.slice(2));

  if (!entryId || !mongoose.Types.ObjectId.isValid(entryId)) {
    console.error(
      "Usage: node scripts/delete-dealer-ledger-entry.js --prod --id=<mongoId> [--execute] [--search]"
    );
    process.exit(1);
  }

  const uri = prod
    ? process.env.PROD_MONGO_URL
    : process.env.MONGO_URL || process.env.STAGE_MONGO_URL || process.env.MONGODB_URI;

  if (!uri) {
    console.error(
      prod
        ? "Missing PROD_MONGO_URL in .env"
        : "Missing MONGO_URL / STAGE_MONGO_URL / MONGODB_URI"
    );
    process.exit(1);
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15000,
  });

  const LedgerModel = mongoose.model("DealerLedgerEntry");
  const collName = LedgerModel.collection.collectionName;
  const dbName = mongoose.connection.name;
  const col = mongoose.connection.db.collection(collName);
  const _id = new mongoose.Types.ObjectId(entryId);

  if (search) {
    const hits = await searchAllCollections(mongoose.connection.db, _id);
    console.log(`Search _id=${entryId} db=${dbName} hits=${hits.length}`);
    for (const h of hits) console.log(h);
    await mongoose.disconnect();
    process.exit(0);
  }

  const doc = await col.findOne({ _id });
  if (!doc) {
    console.log(`No document in ${collName} with _id=${entryId} (db=${dbName})`);
    console.log("Tip: node scripts/delete-dealer-ledger-entry.js --prod --id=... --search");
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log("Found ledger entry (summary):");
  console.log({
    _id: doc._id?.toString?.(),
    dealer: doc.dealer?.toString?.(),
    refType: doc.refType,
    debit: doc.debit,
    credit: doc.credit,
    balanceBefore: doc.balanceBefore,
    balanceAfter: doc.balanceAfter,
    entryDate: doc.entryDate,
    description: doc.description?.slice?.(0, 120),
  });

  if (!execute) {
    console.log("\nDry run only. Re-run with --execute to delete this document.");
    await mongoose.disconnect();
    process.exit(0);
  }

  const result = await col.deleteOne({ _id });
  console.log("\nDelete result:", result);
  await mongoose.disconnect();
  process.exit(result.deletedCount === 1 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
