/**
 * Clear primary/secondary shed flow data (inward + outward lines) for dev reset.
 *
 * Default: DRY-RUN only (prints counts, changes nothing).
 *
 * Usage (from FINAL_NURSERY_BE):
 *   node scripts/clear-shed-flow-data.mjs
 *   node scripts/clear-shed-flow-data.mjs --execute
 *   node scripts/clear-shed-flow-data.mjs --batch-id 69f6df116cc66ad20068dbfc
 *   node scripts/clear-shed-flow-data.mjs --execute --delete-docs   # remove PlantOutward docs entirely
 *   node scripts/clear-shed-flow-data.mjs --execute --prod
 *
 * What --execute does (default mode, not --delete-docs):
 *   - Clears outward (lab), primaryInward, primaryOutward, secondaryInward, secondaryOutward arrays
 *   - Resets summary totals on each PlantOutward doc
 *   - Deletes SecondaryDispatchAvailability ledger rows
 *
 * --keep-lab  Keep lab outward lines (only reset transfer state); default clears lab too.
 *
 * DispatchBatch documents are NOT deleted (batch master stays).
 */
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import PlantOutward from "../models/plantOutward.model.js";
import SecondaryDispatchAvailability from "../models/secondaryDispatchAvailability.model.js";
import "../models/dispatchBatch.model.js";
const EMPTY_SUMMARY = () => ({
  R1: {},
  R2: {},
  R3: {},
  total: {},
});

function parseArgs(argv) {
  const opts = {
    execute: false,
    prod: false,
    deleteDocs: false,
    keepLab: false,
    batchId: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") opts.execute = true;
    else if (a === "--prod") opts.prod = true;
    else if (a === "--delete-docs") opts.deleteDocs = true;
    else if (a === "--keep-lab") opts.keepLab = true;
    else if (a === "--batch-id") opts.batchId = argv[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

function countLines(arr) {
  return Array.isArray(arr) ? arr.length : 0;
}

function sumPlants(arr, field = "totalQuantity") {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((s, row) => {
    const n = Number(row?.availableQuantity ?? row?.[field] ?? row?.plants ?? 0);
    return s + (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
  }, 0);
}

async function loadTargets(batchId) {
  const filter = batchId ? { batchId: new mongoose.Types.ObjectId(batchId) } : {};
  const docs = await PlantOutward.find(filter).lean();
  return docs;
}

function describeDoc(doc) {
  const bn =
    doc.batchId && typeof doc.batchId === "object"
      ? doc.batchId.batchNumber ?? doc.batchId._id
      : doc.batchId;
  return {
    plantOutwardId: String(doc._id),
    batchId: String(doc.batchId?._id ?? doc.batchId),
    batchNumber: bn != null ? String(bn) : "—",
    labLines: countLines(doc.outward),
    primaryInward: countLines(doc.primaryInward),
    primaryOutward: countLines(doc.primaryOutward),
    secondaryInward: countLines(doc.secondaryInward),
    secondaryOutward: countLines(doc.secondaryOutward),
    piPlants: sumPlants(doc.primaryInward),
    poPlants: sumPlants(doc.primaryOutward),
    siPlants: sumPlants(doc.secondaryInward),
    soPlants: sumPlants(doc.secondaryOutward),
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(`See script header for usage. Default is dry-run.`);
    process.exit(0);
  }

  const mongoUrl = opts.prod
    ? process.env.PROD_MONGO_URL
    : process.env.MONGO_URL ||
      process.env.MONGODB_URI ||
      process.env.STAGE_MONGO_URL ||
      "mongodb://localhost:27017/nursery";

  if (!mongoUrl) {
    console.error("Set MONGO_URL in .env");
    process.exit(1);
  }

  await mongoose.connect(mongoUrl);
  const dbName = mongoose.connection.name;
  console.log(`\nConnected: ${opts.prod ? "PROD_MONGO_URL" : "MONGO_URL"} → ${dbName}`);
  console.log(`Mode: ${opts.execute ? "EXECUTE ⚠️" : "DRY-RUN (safe preview)"}`);
  if (opts.batchId) console.log(`Filter batchId: ${opts.batchId}`);
  if (opts.deleteDocs) console.log(`Action: DELETE PlantOutward documents`);
  else if (opts.keepLab)
    console.log(`Action: CLEAR inward/outward arrays + reset lab transfers + ledger`);
  else console.log(`Action: CLEAR lab + all inward/outward arrays + ledger`);
  console.log("");

  if (opts.batchId && !mongoose.Types.ObjectId.isValid(opts.batchId)) {
    console.error("Invalid --batch-id");
    process.exit(1);
  }

  const docs = await loadTargets(opts.batchId);
  const batchFilter = opts.batchId
    ? { dispatchBatchId: new mongoose.Types.ObjectId(opts.batchId) }
    : {};
  const ledgerCount = await SecondaryDispatchAvailability.countDocuments(batchFilter);

  if (!docs.length) {
    console.log("No PlantOutward documents match filter.");
    console.log(`SecondaryDispatchAvailability rows: ${ledgerCount}`);
    await mongoose.disconnect();
    return;
  }

  const rows = docs.map(describeDoc);
  const totals = rows.reduce(
    (acc, r) => {
      acc.labLines += r.labLines;
      acc.primaryInward += r.primaryInward;
      acc.primaryOutward += r.primaryOutward;
      acc.secondaryInward += r.secondaryInward;
      acc.secondaryOutward += r.secondaryOutward;
      acc.piPlants += r.piPlants;
      acc.poPlants += r.poPlants;
      acc.siPlants += r.siPlants;
      acc.soPlants += r.soPlants;
      return acc;
    },
    {
      labLines: 0,
      primaryInward: 0,
      primaryOutward: 0,
      secondaryInward: 0,
      secondaryOutward: 0,
      piPlants: 0,
      poPlants: 0,
      siPlants: 0,
      soPlants: 0,
    },
  );

  console.log("=== SUMMARY (would be affected) ===");
  console.log(`PlantOutward documents:     ${docs.length}`);
  console.log(`Lab outward lines:          ${totals.labLines}`);
  console.log(`Primary inward lines:       ${totals.primaryInward} (${totals.piPlants} plants)`);
  console.log(`Primary outward lines:      ${totals.primaryOutward} (${totals.poPlants} plants)`);
  console.log(`Secondary inward lines:     ${totals.secondaryInward} (${totals.siPlants} plants)`);
  console.log(`Secondary outward lines:    ${totals.secondaryOutward} (${totals.soPlants} plants)`);
  console.log(`SecondaryDispatchAvailability: ${ledgerCount} docs (would delete)`);
  console.log(`DispatchBatch master:       NOT deleted (batches kept)\n`);

  console.log("=== PER BATCH ===");
  for (const r of rows) {
    const flow =
      r.primaryInward +
      r.primaryOutward +
      r.secondaryInward +
      r.secondaryOutward;
    if (flow === 0 && r.labLines === 0) continue;
    console.log(
      `  #${r.batchNumber} (${r.batchId.slice(-6)})` +
        ` | lab:${r.labLines} pi:${r.primaryInward} po:${r.primaryOutward}` +
        ` si:${r.secondaryInward} so:${r.secondaryOutward}`,
    );
  }

  if (!opts.execute) {
    console.log("\n✅ DRY-RUN complete — no changes made.");
    console.log("   To apply: node scripts/clear-shed-flow-data.mjs --execute");
    console.log("   One batch: node scripts/clear-shed-flow-data.mjs --execute --batch-id <id>");
    await mongoose.disconnect();
    return;
  }

  console.log("\n⚠️  Applying changes...");

  if (opts.deleteDocs) {
    const ids = docs.map((d) => d._id);
    const poResult = await PlantOutward.deleteMany({ _id: { $in: ids } });
    const ledgerResult = await SecondaryDispatchAvailability.deleteMany({
      plantOutwardId: { $in: ids },
      ...batchFilter,
    });
    console.log(`Deleted PlantOutward: ${poResult.deletedCount}`);
    console.log(`Deleted ledger: ${ledgerResult.deletedCount}`);
  } else {
    const fullDocs = await PlantOutward.find(
      opts.batchId ? { batchId: opts.batchId } : {},
    );

    let cleared = 0;
    for (const doc of fullDocs) {
      if (opts.keepLab) {
        for (const lab of doc.outward || []) {
          const bottles = Math.max(0, Number(lab.bottles) || 0);
          const plants = Math.max(0, Number(lab.plants) || 0);
          lab.transferHistory = [];
          lab.transferStatus = "available";
          lab.availableBottles = bottles;
          lab.availablePlants = plants;
          lab.primaryReviewStatus = "pending";
          lab.acceptedAt = undefined;
          lab.acceptedBy = undefined;
          lab.rejectionReason = undefined;
        }
      } else {
        doc.outward = [];
      }
      doc.primaryInward = [];
      doc.primaryOutward = [];
      doc.secondaryInward = [];
      doc.secondaryOutward = [];
      doc.summary = EMPTY_SUMMARY();
      doc.markModified("outward");
      doc.markModified("summary");
      await doc.save({ validateModifiedOnly: true });
      cleared += 1;
    }

    const ledgerResult = await SecondaryDispatchAvailability.deleteMany(batchFilter);
    console.log(`Cleared flow arrays on ${cleared} PlantOutward doc(s)`);
    if (opts.keepLab) console.log(`Reset lab transfer state on outward lines`);
    else console.log(`Cleared all lab outward lines`);
    console.log(`Deleted SecondaryDispatchAvailability: ${ledgerResult.deletedCount}`);
  }

  const remaining = await loadTargets(opts.batchId);
  const after = remaining.reduce(
    (acc, d) => {
      acc.pi += countLines(d.primaryInward);
      acc.po += countLines(d.primaryOutward);
      acc.si += countLines(d.secondaryInward);
      acc.so += countLines(d.secondaryOutward);
      return acc;
    },
    { pi: 0, po: 0, si: 0, so: 0 },
  );
  console.log(
    `\nAfter: pi=${after.pi} po=${after.po} si=${after.si} so=${after.so} | docs=${remaining.length}`,
  );
  console.log("✅ Done. Restart FINAL_NURSERY_BE and refresh mobile apps.\n");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
