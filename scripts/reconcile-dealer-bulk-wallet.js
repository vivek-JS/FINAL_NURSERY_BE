/**
 * One-off / maintenance: reconcile DealerWallet.entries from Orders (bulk vs farmer quota).
 * Fixes historical rows where dealer bulk incorrectly increased bookedQuantity.
 *
 * Usage:
 *   DRY_RUN=1 node scripts/reconcile-dealer-bulk-wallet.js
 *   DRY_RUN=0 DEALER_ID=<mongoId> node scripts/reconcile-dealer-bulk-wallet.js
 *
 * Requires: MONGO_URL (or MONGODB_URI) in .env
 */

import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import DealerWallet from "../models/dealerWallet.js";
import { reconcileDealerWalletEntries } from "../utils/dealerWalletReconcile.js";

const MONGO_URL = process.env.MONGO_URL || process.env.MONGODB_URI || "mongodb://localhost:27017/nursery";
const DRY_RUN = process.env.DRY_RUN !== "0" && process.env.DRY_RUN !== "false";
const SINGLE_DEALER = process.env.DEALER_ID || null;

async function main() {
  console.log("\n========== Reconcile dealer wallet (bulk vs farmer) ==========\n");
  console.log(`DRY_RUN: ${DRY_RUN} (set DRY_RUN=0 to apply)`);
  await mongoose.connect(MONGO_URL);
  console.log(`DB: ${mongoose.connection.name}\n`);

  const dealerIds = SINGLE_DEALER
    ? [SINGLE_DEALER]
    : (await DealerWallet.distinct("dealer")).map((id) => id.toString());

  if (!dealerIds.length) {
    console.log("No DealerWallet documents found.");
    await mongoose.disconnect();
    process.exit(0);
  }

  let totalChanges = 0;
  for (const id of dealerIds) {
    const result = await reconcileDealerWalletEntries(id, { dryRun: DRY_RUN });
    const n = result.changes?.length ?? 0;
    if (n > 0) {
      console.log(`Dealer ${id}: ${n} line(s) ${DRY_RUN ? "would change" : "updated"}`);
      totalChanges += n;
      if (DRY_RUN) {
        console.log(JSON.stringify(result.changes, null, 2));
      }
    }
  }

  console.log(`\nDone. Dealers processed: ${dealerIds.length}, lines with diffs: ${totalChanges}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
