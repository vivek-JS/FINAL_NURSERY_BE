/**
 * Replace the orders covered by one completed sow entry on PROD.
 * Unlinks every order currently marked sowed by the request (sowingDone → false),
 * links the given orders instead, and re-splits the slot batch (covered / excess / mortality).
 *
 *   TZ=UTC node scripts/relink-sow-orders-prod.mjs           # dry-run
 *   TZ=UTC node scripts/relink-sow-orders-prod.mjs --apply
 */
import "dotenv/config";
import mongoose from "mongoose";
import { sowQtySlotImpact } from "../utility/lagwadSlotPlantsSplit.js";

const REQUEST_NUMBER = "SR202610160013";
const LINK_ORDER_IDS = [4052, 4053];
const APPLY = process.argv.includes("--apply");
const BLOCKED = ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED", "DISPATCHED", "COMPLETED"];

const plants = (o) => (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0);

await mongoose.connect(process.env.PROD_MONGO_URL);
const db = mongoose.connection.db;
const Requests = db.collection("sowingrequests");
const Orders = db.collection("orders");
const Slots = db.collection("plantslots");

const req = await Requests.findOne({ requestNumber: REQUEST_NUMBER });
if (!req?.sowingCompleted) throw new Error(`${REQUEST_NUMBER} not found or not completed`);

const [loc] = await Slots.aggregate([
  { $unwind: "$subtypeSlots" },
  { $unwind: "$subtypeSlots.slots" },
  { $unwind: "$subtypeSlots.slots.sowingBatches" },
  { $match: { "subtypeSlots.slots.sowingBatches.sowingRequestId": req._id } },
  {
    $project: {
      slotId: "$subtypeSlots.slots._id",
      startDay: "$subtypeSlots.slots.startDay",
      batch: "$subtypeSlots.slots.sowingBatches",
    },
  },
]).toArray();
if (!loc) throw new Error("Sow batch not found on any slot");
const batch = loc.batch;

const current = await Orders.find({ sowingDoneRequestId: req._id }).toArray();
const targets = await Orders.find({ orderId: { $in: LINK_ORDER_IDS } }).toArray();
if (targets.length !== LINK_ORDER_IDS.length) throw new Error("Some target orders not found");
for (const o of targets) {
  if (String(o.plantSubtype) !== String(req.subtypeId)) throw new Error(`#${o.orderId} is a different variety`);
  if (BLOCKED.includes(o.orderStatus)) throw new Error(`#${o.orderId} status ${o.orderStatus}`);
  if (o.sowingDone && String(o.sowingDoneRequestId) !== String(req._id)) {
    throw new Error(`#${o.orderId} already sowed by another request`);
  }
}

const sowed = Number(batch.plantsSowed) || 0;
const coverNeed = targets.reduce((s, o) => s + plants(o), 0);
if (coverNeed > sowed) throw new Error(`Orders need ${coverNeed} > sowed ${sowed}`);
const covered = coverNeed;
const excess = sowed - covered;
const impact = sowQtySlotImpact(sowed, { excessPlants: excess, orderCoveredPlants: covered });

const was = {
  actual: Number(batch.actualPlantsApplied) || 0,
  mort: Number(batch.expectedMortalityApplied) || 0,
  avail: Number(batch.availablePlantsApplied) || 0,
  reserved: Number(batch.orderReservedPlantsApplied) || 0,
};
const d = {
  actual: impact.actualPlants - was.actual,
  mort: impact.expectedMortality - was.mort,
  avail: impact.availablePlants - was.avail,
  reserved: impact.orderReservedPlants - was.reserved,
};

console.log(`${APPLY ? "APPLY" : "DRY-RUN"} relink ${REQUEST_NUMBER} · ${req.subtypeName} · sowed ${sowed} · slot ${loc.startDay}`);
console.log("Unlink:", current.map((o) => `#${o.orderId} (${plants(o)})`).join(", ") || "—");
console.log("Link:  ", targets.map((o) => `#${o.orderId} (${plants(o)}, ${o.orderStatus})`).join(", "));
console.log(
  `Batch covered ${batch.orderCoveredPlants} → ${covered} · excess ${batch.excessPlants} → ${excess} · ` +
    `actual ${was.actual} → ${impact.actualPlants} · mort ${was.mort} → ${impact.expectedMortality} · ` +
    `avail ${was.avail} → ${impact.availablePlants} · reserved ${was.reserved} → ${impact.orderReservedPlants}`
);

if (APPLY) {
  const unlinkIds = current.map((o) => o._id).filter((id) => !targets.some((t) => String(t._id) === String(id)));
  const sowedAt = batch.sowedAt || req.sowingCompletedDate;
  const now = new Date();
  const session = await mongoose.startSession();
  await session.withTransaction(async () => {
    if (unlinkIds.length) {
      await Orders.updateMany(
        { _id: { $in: unlinkIds }, sowingDoneRequestId: req._id },
        { $set: { sowingDone: false }, $unset: { sowingDoneAt: "", sowingDoneRequestId: "" } },
        { session }
      );
    }
    await Orders.updateMany(
      { _id: { $in: targets.map((o) => o._id) } },
      { $set: { sowingDone: true, sowingDoneAt: sowedAt, sowingDoneRequestId: req._id } },
      { session }
    );

    const B = "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b]";
    const S = "subtypeSlots.$[st].slots.$[sl]";
    const inc = {};
    if (d.actual) inc[`${S}.actualPlants`] = d.actual;
    if (d.mort) inc[`${S}.expectedMortality`] = d.mort;
    if (d.avail) {
      inc[`${S}.availablePlants`] = d.avail;
      inc[`${S}.excessiveSowing.plants`] = d.avail;
    }
    if (d.reserved) inc[`${S}.orderReservedPlants`] = d.reserved;
    const res = await Slots.updateOne(
      { "subtypeSlots.slots._id": loc.slotId },
      {
        $set: {
          [`${B}.orderCoveredPlants`]: covered,
          [`${B}.excessPlants`]: excess,
          [`${B}.actualPlantsApplied`]: impact.actualPlants,
          [`${B}.expectedMortalityApplied`]: impact.expectedMortality,
          [`${B}.availablePlantsApplied`]: impact.availablePlants,
          [`${B}.orderReservedPlantsApplied`]: impact.orderReservedPlants,
          [`${B}.linkedOrderIds`]: targets.map((o) => o._id),
        },
        ...(Object.keys(inc).length ? { $inc: inc } : {}),
      },
      {
        arrayFilters: [{ "st.slots._id": loc.slotId }, { "sl._id": loc.slotId }, { "b._id": batch._id }],
        session,
      }
    );
    if (res.modifiedCount !== 1) throw new Error("Slot batch update failed");

    const events = req.completionEvents || [];
    const i = events.findIndex((e) => e.type === "SOW_COMPLETED");
    const set = { linkedOrderIds: targets.map((o) => o._id) };
    if (i >= 0) {
      set[`completionEvents.${i}.meta.orderCoveredPlants`] = covered;
      set[`completionEvents.${i}.meta.excessPlants`] = excess;
      set[`completionEvents.${i}.meta.ordersMarked`] = targets.length;
      set[`completionEvents.${i}.meta.remainingUncovered`] = excess;
    }
    await Requests.updateOne({ _id: req._id }, { $set: { ...set, updatedAt: now } }, { session });
    await Requests.updateOne(
      { _id: req._id },
      {
        $push: {
          completionEvents: {
            type: "NOTE",
            at: now,
            quantity: covered,
            unit: "plants",
            message:
              `Orders relinked: removed ${current.map((o) => `#${o.orderId}`).join(", ") || "—"}; ` +
              `covered ${targets.map((o) => `#${o.orderId}`).join(", ")} (${covered} plants)`,
            meta: {
              editType: "ORDERS_RELINKED",
              unlinkedOrderIds: current.map((o) => o.orderId),
              linkedOrderIds: targets.map((o) => o.orderId),
              orderCoveredPlants: covered,
              excessPlants: excess,
            },
          },
        },
      },
      { session }
    );
  });
  await session.endSession();
  console.log("APPLIED");
}

await mongoose.disconnect();
