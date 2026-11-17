/**
 * Close Capacity Remaining vs Current / slot Actual ready gaps on
 * calendar-ready linked secondary inward lines:
 *   slotStockSyncedPlants := availableQuantity
 *   slot.actualReadyPlants += (avail - synced)
 *
 * Usage:
 *   node scripts/align-synced-to-available-ready.mjs
 *   node scripts/align-synced-to-available-ready.mjs --apply
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import moment from "moment";
dotenv.config({ path: ".env" });

const APPLY = process.argv.includes("--apply");

await mongoose.connect(process.env.PROD_MONGO_URL || process.env.MONGO_URL);
await import("../models/farmer.model.js");
await import("../models/dispatchBatch.model.js");
await import("../models/plantCms.model.js");
const PlantOutward = (await import("../models/plantOutward.model.js")).default;
const PlantSlot = (await import("../models/slots.model.js")).default;
const { secondaryInwardCalendarReady } = await import(
  "../services/secondaryShedSlotStock.service.js"
);
const { applyStockFieldUpdates } = await import("../utility/slotStockTrail.js");

const today = moment().startOf("day");
const pos = await PlantOutward.find({
  "secondaryInward.linkedBookingSlotId": { $exists: true, $ne: null },
})
  .select("batchId secondaryInward")
  .populate({ path: "batchId", select: "batchNumber secondaryPlantReadyDays" });

const bySlot = new Map();
let lineCount = 0;
let totalDelta = 0;

for (const po of pos) {
  const batch = po.batchId && typeof po.batchId === "object" ? po.batchId : null;
  for (const si of po.secondaryInward || []) {
    if (!si.linkedBookingSlotId) continue;
    if (!secondaryInwardCalendarReady(si, batch, today)) continue;
    const avail = Math.max(0, Math.floor(Number(si.availableQuantity) || 0));
    const synced = Math.max(0, Math.floor(Number(si.slotStockSyncedPlants) || 0));
    const gap = avail - synced;
    if (gap < 1) continue;
    const slotId = String(si.linkedBookingSlotId);
    if (!bySlot.has(slotId)) bySlot.set(slotId, { delta: 0, lines: [] });
    const bucket = bySlot.get(slotId);
    bucket.delta += gap;
    bucket.lines.push({
      poId: po._id,
      siId: si._id,
      batch: batch?.batchNumber || "",
      shed: si.pollyhouse || "",
      avail,
      synced,
      gap,
    });
    lineCount += 1;
    totalDelta += gap;
  }
}

console.log({ mode: APPLY ? "APPLY" : "DRY", lineCount, totalDelta, slots: bySlot.size });
for (const [sid, b] of [...bySlot.entries()].sort((a, c) => c[1].delta - a[1].delta)) {
  console.log(`  slot …${sid.slice(-6)} +${b.delta} · ${b.lines.length} lines`);
}

if (!APPLY) {
  console.log("Re-run with --apply to write");
  await mongoose.disconnect();
  process.exit(0);
}

const session = await mongoose.startSession();
session.startTransaction();
try {
  for (const [slotId, bucket] of bySlot) {
    for (const ln of bucket.lines) {
      await PlantOutward.updateOne(
        { _id: ln.poId, "secondaryInward._id": ln.siId },
        {
          $set: { "secondaryInward.$.slotStockSyncedPlants": ln.avail },
          $push: {
            "secondaryInward.$.activityLog": {
              action: "SLOT_SYNC_ALIGN",
              activityName: `Synced ready raised to stock · +${ln.gap}`,
              performedAt: new Date(),
              quantity: ln.gap,
              previousValue: {
                slotStockSyncedPlants: ln.synced,
                availableQuantity: ln.avail,
              },
              newValue: {
                slotStockSyncedPlants: ln.avail,
                availableQuantity: ln.avail,
              },
              reason: "Close Capacity Current vs Remaining / slot ready gap",
            },
          },
        },
        { session }
      );
    }

    const plantSlot = await PlantSlot.findOne({
      "subtypeSlots.slots._id": slotId,
    }).session(session);
    if (!plantSlot) {
      console.warn("slot missing", slotId);
      continue;
    }
    let slotDoc = null;
    for (const st of plantSlot.subtypeSlots || []) {
      const slots = st.slots || [];
      slotDoc =
        typeof slots.id === "function"
          ? slots.id(slotId)
          : slots.find((s) => String(s._id) === slotId);
      if (slotDoc) break;
    }
    if (!slotDoc) {
      console.warn("slot subdoc missing", slotId);
      continue;
    }
    const prev = Math.max(0, Number(slotDoc.actualReadyPlants) || 0);
    applyStockFieldUpdates(
      slotDoc,
      { actualReadyPlants: prev + bucket.delta },
      null,
      `Align synced to stock · +${bucket.delta} ready`
    );
    await plantSlot.save({ session, validateBeforeSave: true });
    console.log(`slot …${slotId.slice(-6)} actualReady ${prev} → ${prev + bucket.delta}`);
  }
  await session.commitTransaction();
  console.log("COMMITTED");
} catch (e) {
  await session.abortTransaction();
  throw e;
} finally {
  session.endSession();
}

await mongoose.disconnect();
