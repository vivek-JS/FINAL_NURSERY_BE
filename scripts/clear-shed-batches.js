/**
 * Clear all shed-ops batches and their primary/secondary inward-outward ledger.
 *
 * Collections targeted:
 *   - DispatchBatch                (the batches)
 *   - PlantOutward                 (lab outward + primaryInward/primaryOutward + secondaryInward/secondaryOutward)
 *   - SecondaryDispatchAvailability (derived secondary FIFO availability cache, keyed by batch)
 *
 * Usage (from FINAL_NURSERY_BE with .env present):
 *   node scripts/clear-shed-batches.js --prod            # DRY RUN against prod (default)
 *   node scripts/clear-shed-batches.js --prod --execute  # actually delete on prod
 *   node scripts/clear-shed-batches.js                   # DRY RUN against MONGO_URL
 *
 * Options:
 *   --prod        Use PROD_MONGO_URL instead of MONGO_URL
 *   --execute     Apply deletions (default is dry-run preview only)
 */
import "dotenv/config";
import mongoose from "mongoose";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import SecondaryDispatchAvailability from "../models/secondaryDispatchAvailability.model.js";

function parseArgs(argv) {
  const opts = { execute: false, prod: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") opts.execute = true;
    else if (a === "--prod") opts.prod = true;
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

async function summarizePlantOutward() {
  const result = await PlantOutward.aggregate([
    {
      $group: {
        _id: null,
        docs: { $sum: 1 },
        labOutward: { $sum: { $size: { $ifNull: ["$outward", []] } } },
        primaryInward: { $sum: { $size: { $ifNull: ["$primaryInward", []] } } },
        primaryOutward: { $sum: { $size: { $ifNull: ["$primaryOutward", []] } } },
        secondaryInward: { $sum: { $size: { $ifNull: ["$secondaryInward", []] } } },
        secondaryOutward: { $sum: { $size: { $ifNull: ["$secondaryOutward", []] } } },
      },
    },
  ]);
  return (
    result[0] || {
      docs: 0,
      labOutward: 0,
      primaryInward: 0,
      primaryOutward: 0,
      secondaryInward: 0,
      secondaryOutward: 0,
    }
  );
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(`
Clear shed-ops batches + primary/secondary inward-outward ledger.

  node scripts/clear-shed-batches.js --prod            # dry run (prod)
  node scripts/clear-shed-batches.js --prod --execute  # delete (prod)
`);
    process.exit(0);
  }

  const mongoUrl = opts.prod ? process.env.PROD_MONGO_URL : process.env.MONGO_URL;
  if (!mongoUrl) {
    console.error(opts.prod ? "Set PROD_MONGO_URL in .env" : "Set MONGO_URL in .env");
    process.exit(1);
  }

  await mongoose.connect(mongoUrl);
  const dbName = mongoose.connection?.db?.databaseName || "(unknown)";
  console.log(opts.prod ? "Connected: PROD_MONGO_URL" : "Connected: MONGO_URL", `(db: ${dbName})`);
  console.log("Mode:", opts.execute ? "EXECUTE (will delete)" : "DRY-RUN (pass --execute to apply)");
  console.log("");

  const [batchCount, poSummary, availabilityCount] = await Promise.all([
    DispatchBatch.countDocuments({}),
    summarizePlantOutward(),
    SecondaryDispatchAvailability.countDocuments({}),
  ]);

  console.log("Will be DELETED:");
  console.log(`  DispatchBatch (batches) ............ ${batchCount}`);
  console.log(`  PlantOutward documents ............. ${poSummary.docs}`);
  console.log(`    - lab outward entries ............ ${poSummary.labOutward}`);
  console.log(`    - primaryInward entries .......... ${poSummary.primaryInward}`);
  console.log(`    - primaryOutward entries ......... ${poSummary.primaryOutward}`);
  console.log(`    - secondaryInward entries ........ ${poSummary.secondaryInward}`);
  console.log(`    - secondaryOutward entries ....... ${poSummary.secondaryOutward}`);
  console.log(`  SecondaryDispatchAvailability ...... ${availabilityCount}`);
  console.log("");

  const nothingToDo =
    batchCount === 0 && poSummary.docs === 0 && availabilityCount === 0;
  if (nothingToDo) {
    console.log("Nothing to delete. Exiting.");
    await mongoose.disconnect();
    return;
  }

  if (!opts.execute) {
    console.log("Dry-run only. No data was modified.");
    console.log("Re-run with --execute (and --prod for prod) to actually delete the above.");
    await mongoose.disconnect();
    return;
  }

  console.log("Deleting...");
  const [poDel, availDel, batchDel] = [
    await PlantOutward.deleteMany({}),
    await SecondaryDispatchAvailability.deleteMany({}),
    await DispatchBatch.deleteMany({}),
  ];

  console.log("");
  console.log("Deleted:");
  console.log(`  PlantOutward ....................... ${poDel.deletedCount}`);
  console.log(`  SecondaryDispatchAvailability ...... ${availDel.deletedCount}`);
  console.log(`  DispatchBatch ...................... ${batchDel.deletedCount}`);

  await mongoose.disconnect();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
