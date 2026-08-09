/**
 * Recompute ready-slot availablePlants (sale) vs orderReservedPlants
 * from sowingBatches orderCoveredPlants / excessPlants.
 *
 *   node scripts/backfill-slot-reserved-saleable-prod.mjs           # dry-run
 *   node scripts/backfill-slot-reserved-saleable-prod.mjs --apply
 */
import "dotenv/config";
import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";

const APPLY = process.argv.includes("--apply");
const DRY = !APPLY;

function prodUri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL required");
  return url;
}

async function main() {
  console.log(
    `\n=== Slot reserved vs saleable backfill ===\nMODE: ${
      DRY ? "DRY-RUN" : "APPLY"
    }\n`
  );
  await mongoose.connect(prodUri(), { maxPoolSize: 5 });

  const rows = await PlantSlot.aggregate([
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    {
      $match: {
        $or: [
          { "subtypeSlots.slots.plantsSowed": { $gt: 0 } },
          { "subtypeSlots.slots.primarySowed": { $gt: 0 } },
          { "subtypeSlots.slots.sowingBatches.0": { $exists: true } },
        ],
      },
    },
    {
      $project: {
        plantId: 1,
        subtypeId: "$subtypeSlots.subtypeId",
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        plantsSowed: { $ifNull: ["$subtypeSlots.slots.plantsSowed", 0] },
        primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
        availablePlants: { $ifNull: ["$subtypeSlots.slots.availablePlants", 0] },
        orderReservedPlants: {
          $ifNull: ["$subtypeSlots.slots.orderReservedPlants", 0],
        },
        excessivePlants: {
          $ifNull: ["$subtypeSlots.slots.excessiveSowing.plants", 0],
        },
        batches: { $ifNull: ["$subtypeSlots.slots.sowingBatches", []] },
      },
    },
    { $limit: 2000 },
  ]);

  let changes = 0;
  for (const sl of rows) {
    let reserved = 0;
    let excess = 0;
    const reqIds = [];
    for (const b of sl.batches || []) {
      const c = Math.max(0, Number(b.orderCoveredPlants) || 0);
      const e = Math.max(0, Number(b.excessPlants) || 0);
      reserved += c;
      excess += e;
      if (b.sowingRequestId) reqIds.push(b.sowingRequestId);
      if (b.isExcessiveSowing && c <= 0 && e <= 0) {
        excess += Math.max(0, Number(b.plantsSowed) || 0);
      }
    }

    // Fallback: sum covered order plants for batch request ids
    if (reserved <= 0 && reqIds.length) {
      const covered = await Order.find({
        sowingDone: true,
        sowingDoneRequestId: { $in: reqIds },
      })
        .select("numberOfPlants additionalPlants")
        .lean();
      reserved = covered.reduce(
        (s, o) =>
          s +
          (Number(o.numberOfPlants) || 0) +
          (Number(o.additionalPlants) || 0),
        0
      );
      const physical = Math.max(
        Number(sl.plantsSowed) || 0,
        Number(sl.primarySowed) || 0
      );
      if (excess <= 0) excess = Math.max(0, physical - reserved);
    }

    const physical = Math.max(
      Number(sl.plantsSowed) || 0,
      Number(sl.primarySowed) || 0
    );

    if (reserved <= 0 && excess <= 0) {
      // All physical currently in available — split using excessive if set
      const exStored = Math.max(0, Number(sl.excessivePlants) || 0);
      if (exStored > 0) {
        excess = Math.min(exStored, physical);
        reserved = Math.max(0, physical - excess);
      } else if (physical > 0 && Number(sl.availablePlants) >= physical) {
        // Legacy: everything saleable — leave as-is unless we have order cover
        continue;
      }
    }

    // Never reserve more than physical on this ready slot (cross-slot cover fallback)
    if (reserved > physical) {
      reserved = physical;
      excess = 0;
    } else if (reserved + excess > physical && physical > 0) {
      excess = Math.max(0, physical - reserved);
    }

    const nextAvail = excess;
    const nextReserved = reserved;
    const curAvail = Number(sl.availablePlants) || 0;
    const curRes = Number(sl.orderReservedPlants) || 0;
    if (curAvail === nextAvail && curRes === nextReserved) continue;

    changes += 1;
    console.log(
      `${sl.startDay || sl.slotId} | avail ${curAvail}→${nextAvail} · reserved ${curRes}→${nextReserved} · excessStored ${sl.excessivePlants}`
    );

    if (!DRY) {
      await PlantSlot.updateOne(
        { "subtypeSlots.slots._id": sl.slotId },
        {
          $set: {
            "subtypeSlots.$[st].slots.$[sl].availablePlants": nextAvail,
            "subtypeSlots.$[st].slots.$[sl].orderReservedPlants": nextReserved,
            "subtypeSlots.$[st].slots.$[sl].excessiveSowing.plants": nextAvail,
          },
        },
        {
          arrayFilters: [
            { "st.slots._id": sl.slotId },
            { "sl._id": sl.slotId },
          ],
        }
      );
    }
  }

  console.log(`\nSlots to update: ${changes}`);
  if (DRY) console.log("Dry-run only. Re-run with --apply to write.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
