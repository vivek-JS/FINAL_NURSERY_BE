/**
 * Clamp secondaryInward.slotStockSyncedPlants to availableQuantity where
 * synced > avail (historical dispatch burned stock but not synced).
 * Then set slot.actualReadyPlants = sum of calendar-ready effective synced.
 *
 * Usage: node scripts/reconcile-synced-to-available.mjs [--slot <id>] [--apply]
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import moment from "moment";
dotenv.config({ path: ".env" });

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const slotIdx = args.indexOf("--slot");
const onlySlot = slotIdx >= 0 ? String(args[slotIdx + 1] || "").trim() : "";

await mongoose.connect(process.env.PROD_MONGO_URL || process.env.MONGODB_URI);
const PlantOutward = (await import("../models/plantOutward.model.js")).default;
const PlantSlot = (await import("../models/slots.model.js")).default;
const {
  secondaryInwardCalendarReady,
  effectiveSyncedOnSlot,
} = await import("../services/secondaryShedSlotStock.service.js");

const match = onlySlot
  ? { "secondaryInward.linkedBookingSlotId": new mongoose.Types.ObjectId(onlySlot) }
  : { "secondaryInward.slotStockSyncedPlants": { $gt: 0 } };

const pos = await PlantOutward.find(match)
  .select("batchId secondaryInward")
  .populate({ path: "batchId", select: "batchNumber secondaryPlantReadyDays" })
  .lean();

const today = moment().startOf("day");
const lineFixes = [];
const readyBySlot = new Map(); // slotId -> { beforeStored?, afterSum, excess }

for (const po of pos) {
  const batchLean = po.batchId && typeof po.batchId === "object" ? po.batchId : null;
  for (const si of po.secondaryInward || []) {
    const slotId = si.linkedBookingSlotId ? String(si.linkedBookingSlotId) : "";
    if (!slotId) continue;
    if (onlySlot && slotId !== onlySlot) continue;
    const avail = Math.max(0, Number(si.availableQuantity) || 0);
    const syncedRaw = Math.max(0, Number(si.slotStockSyncedPlants) || 0);
    const effective = effectiveSyncedOnSlot(avail, syncedRaw);
    const excess = Math.max(0, syncedRaw - effective);
    if (excess > 0) {
      lineFixes.push({
        plantOutwardId: po._id,
        secondaryInwardId: si._id,
        batch: batchLean?.batchNumber || "",
        polly: si.pollyhouse,
        slotId,
        avail,
        syncedRaw,
        effective,
        excess,
      });
    }
    const calReady = secondaryInwardCalendarReady(si, batchLean, today);
    if (!readyBySlot.has(slotId)) {
      readyBySlot.set(slotId, { afterSum: 0, excess: 0, lineExcess: 0 });
    }
    const bucket = readyBySlot.get(slotId);
    if (calReady) bucket.afterSum += effective;
    if (excess > 0) {
      bucket.lineExcess += excess;
      if (calReady) bucket.excess += excess;
    }
  }
}

console.log(`Lines with synced > avail: ${lineFixes.length}`);
console.log(
  "Top by excess:",
  lineFixes
    .sort((a, b) => b.excess - a.excess)
    .slice(0, 15)
    .map((r) => `${r.batch} ${r.polly}: ${r.syncedRaw}→${r.effective} (−${r.excess})`)
);

const slotIds = [...readyBySlot.keys()].filter((id) => mongoose.isValidObjectId(id));
for (const sid of slotIds) {
  const doc = await PlantSlot.findOne({ "subtypeSlots.slots._id": sid }).lean();
  if (!doc) continue;
  for (const st of doc.subtypeSlots || []) {
    const s = (st.slots || []).find((x) => String(x._id) === sid);
    if (!s) continue;
    const before = Math.max(0, Number(s.actualReadyPlants) || 0);
    const after = readyBySlot.get(sid).afterSum;
    readyBySlot.get(sid).beforeStored = before;
    readyBySlot.get(sid).window = `${s.startDay}–${s.endDay}`;
    if (before !== after || readyBySlot.get(sid).lineExcess > 0) {
      console.log(
        `SLOT ${sid} ${readyBySlot.get(sid).window}: stored ${before} → ${after} (line excess ${readyBySlot.get(sid).lineExcess})`
      );
    }
  }
}

if (!apply) {
  console.log("Dry-run only. Re-run with --apply to write.");
  await mongoose.disconnect();
  process.exit(0);
}

let linesUpdated = 0;
for (const fix of lineFixes) {
  const r = await PlantOutward.updateOne(
    { _id: fix.plantOutwardId, "secondaryInward._id": fix.secondaryInwardId },
    { $set: { "secondaryInward.$.slotStockSyncedPlants": fix.effective } }
  );
  if (r.modifiedCount) linesUpdated += 1;
}

let slotsUpdated = 0;
for (const [sid, meta] of readyBySlot) {
  if (!mongoose.isValidObjectId(sid)) continue;
  if (meta.beforeStored == null) continue;
  // Only rewrite when lines had synced>avail drift — never zero future slots with no excess.
  if (meta.lineExcess < 1) continue;
  if (meta.beforeStored === meta.afterSum) continue;
  const oid = new mongoose.Types.ObjectId(sid);
  const r = await PlantSlot.updateOne(
    { "subtypeSlots.slots._id": oid },
    {
      $set: {
        "subtypeSlots.$[st].slots.$[sl].actualReadyPlants": meta.afterSum,
      },
    },
    { arrayFilters: [{ "st.slots._id": oid }, { "sl._id": oid }] }
  );
  if (r.modifiedCount) slotsUpdated += 1;
}

console.log(`Applied: lines ${linesUpdated}, slots ${slotsUpdated}`);
await mongoose.disconnect();
