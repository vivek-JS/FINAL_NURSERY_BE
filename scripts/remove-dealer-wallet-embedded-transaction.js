/**
 * Remove one embedded subdocument from DealerWallet.transactions (not DealerLedgerEntry _id).
 * Restores availableAmount to that transaction's balanceBefore (reverts the movement).
 * Optionally deletes matching dealerledgerentries row (same dealer, credit/debit, balanceAfter).
 *
 * Usage (from FINAL_NURSERY_BE):
 *   node scripts/remove-dealer-wallet-embedded-transaction.js --prod --txId=69db7b01afb7b1fdf89a9a56
 *   node scripts/remove-dealer-wallet-embedded-transaction.js --prod --txId=... --execute
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import DealerWallet from "../models/dealerWallet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

function parseArgs(argv) {
  const out = { prod: false, txId: null, execute: false, skipLedger: false };
  for (const a of argv) {
    if (a === "--prod") out.prod = true;
    else if (a === "--execute") out.execute = true;
    else if (a === "--skip-ledger") out.skipLedger = true;
    else if (a.startsWith("--txId=")) out.txId = a.slice(7);
  }
  return out;
}

async function main() {
  const { prod, txId, execute, skipLedger } = parseArgs(process.argv.slice(2));

  if (!txId || !mongoose.Types.ObjectId.isValid(txId)) {
    console.error(
      "Usage: node scripts/remove-dealer-wallet-embedded-transaction.js --prod --txId=<subdocId> [--execute] [--skip-ledger]"
    );
    process.exit(1);
  }

  const uri = prod
    ? process.env.PROD_MONGO_URL
    : process.env.MONGO_URL || process.env.STAGE_MONGO_URL || process.env.MONGODB_URI;

  if (!uri) {
    console.error(prod ? "Missing PROD_MONGO_URL" : "Missing MONGO_URL / STAGE_MONGO_URL");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const oid = new mongoose.Types.ObjectId(txId);
  const wallet = await DealerWallet.findOne({ "transactions._id": oid }).lean();

  if (!wallet) {
    console.error(`No DealerWallet found with transactions._id=${txId} (db=${mongoose.connection.name})`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const tx = (wallet.transactions || []).find((t) => String(t._id) === String(oid));
  if (!tx) {
    console.error("Transaction subdocument not found on wallet");
    await mongoose.disconnect();
    process.exit(1);
  }

  const newAvailable = Number(tx.balanceBefore);
  const later = (wallet.transactions || []).filter((t) => {
    const ta = t.createdAt ? new Date(t.createdAt).getTime() : 0;
    const tb = tx.createdAt ? new Date(tx.createdAt).getTime() : 0;
    return ta > tb;
  });
  if (later.length > 0) {
    console.warn(
      "WARNING: There are transactions after this one by time. Removing may leave inconsistent history; verify manually."
    );
  }

  console.log("Wallet:", wallet._id.toString(), "dealer:", wallet.dealer?.toString?.());
  console.log("Remove tx:", {
    _id: tx._id?.toString?.(),
    type: tx.type,
    amount: tx.amount,
    balanceBefore: tx.balanceBefore,
    balanceAfter: tx.balanceAfter,
    description: tx.description?.slice?.(0, 100),
  });
  console.log("Set availableAmount ->", newAvailable);

  // Matching ledger row (manual credit wrote ADJUSTMENT / credit)
  const ledgerCol = mongoose.connection.db.collection("dealerledgerentries");
  const ledgerMatch = await ledgerCol
    .find({
      dealer: wallet.dealer,
      credit: Number(tx.amount),
      balanceAfter: Number(tx.balanceAfter),
      balanceBefore: Number(tx.balanceBefore),
    })
    .limit(3)
    .toArray();

  if (!skipLedger && ledgerMatch.length > 0) {
    console.log(
      "Ledger row(s) matching amount chain:",
      ledgerMatch.map((d) => ({ _id: d._id.toString(), entryDate: d.entryDate }))
    );
  } else if (!skipLedger) {
    console.log("No dealerledgerentries row matched credit/balanceAfter/balanceBefore (ok if ledger write failed earlier).");
  }

  if (!execute) {
    console.log("\nDry run. Add --execute to apply $pull + availableAmount update" + (skipLedger ? "" : " + ledger delete"));
    await mongoose.disconnect();
    process.exit(0);
  }

  const res = await DealerWallet.updateOne(
    { _id: wallet._id },
    {
      $pull: { transactions: { _id: oid } },
      $set: { availableAmount: newAvailable },
    }
  );
  console.log("Wallet update:", res.modifiedCount === 1 ? "OK" : res);

  if (!skipLedger && ledgerMatch.length === 1) {
    const del = await ledgerCol.deleteOne({ _id: ledgerMatch[0]._id });
    console.log("Ledger deleteOne:", del.deletedCount === 1 ? "OK" : del);
  } else if (!skipLedger && ledgerMatch.length > 1) {
    console.warn("Multiple ledger matches; not auto-deleting. Delete manually if needed:", ledgerMatch.map((d) => d._id.toString()));
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
