/**
 * Heal MoneyLedgerEntry.entryDate placeholders → IST start-of-day.
 * NODE_ENV=production node scripts/healMoneyLedgerEntryDatesIst.mjs
 */
import "dotenv/config";
import mongoose from "mongoose";
import MoneyLedgerEntry from "../models/moneyLedgerEntry.model.js";
import { normalizeLedgerEntryDate, toIstYmd, formatIstDateTime } from "../utility/istLedgerDate.js";

const uri =
  process.env.NODE_ENV === "production"
    ? process.env.PROD_MONGO_URL || process.env.MONGO_URL
    : process.env.MONGO_URL || process.env.STAGE_MONGO_URL;

await mongoose.connect(uri);

const rows = await MoneyLedgerEntry.find({}).select("_id entryDate documentNumber refType").lean();
let updated = 0;
const samples = [];

for (const r of rows) {
  const before = new Date(r.entryDate);
  const after = normalizeLedgerEntryDate(before);
  if (before.getTime() === after.getTime()) continue;
  await MoneyLedgerEntry.collection.updateOne(
    { _id: r._id },
    { $set: { entryDate: after } }
  );
  updated += 1;
  if (samples.length < 12) {
    samples.push({
      doc: r.documentNumber,
      ref: r.refType,
      beforeISO: before.toISOString(),
      beforeIST: formatIstDateTime(before),
      afterISO: after.toISOString(),
      afterIST: formatIstDateTime(after),
      ymd: toIstYmd(after),
    });
  }
}

console.log(JSON.stringify({ scanned: rows.length, updated, samples }, null, 2));
await mongoose.disconnect();
