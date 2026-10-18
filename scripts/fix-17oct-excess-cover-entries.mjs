/**
 * 17 Oct "cover from excess" created a second sowing entry.
 * Put the cover back on the original sowing and delete that extra entry.
 *
 *   node scripts/fix-17oct-excess-cover-entries.mjs
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const SLOT = "subtypeSlots.$[st].slots.$[sl]";
const BATCH = `${SLOT}.sowingBatches.$[b]`;

function oid(id) {
  return new mongoose.Types.ObjectId(id);
}
function n(v) {
  return Math.max(0, Math.floor(Number(v) || 0));
}

async function findBatch(batchId) {
  const id = oid(batchId);
  const [row] = await PlantSlot.aggregate([
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $unwind: "$subtypeSlots.slots.sowingBatches" },
    { $match: { "subtypeSlots.slots.sowingBatches._id": id } },
    {
      $project: {
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        primarySowed: "$subtypeSlots.slots.primarySowed",
        plantsSowed: "$subtypeSlots.slots.plantsSowed",
        totalPlants: "$subtypeSlots.slots.totalPlants",
        actualPlants: "$subtypeSlots.slots.actualPlants",
        expectedMortality: "$subtypeSlots.slots.expectedMortality",
        orderReservedPlants: "$subtypeSlots.slots.orderReservedPlants",
        batch: "$subtypeSlots.slots.sowingBatches",
      },
    },
  ]);
  return row || null;
}

function filters(slotId, batchId) {
  const s = oid(slotId);
  const b = oid(batchId);
  return [{ "st.slots._id": s }, { "sl._id": s }, { "b._id": b }];
}

async function main() {
  await mongoose.connect(process.env.PROD_MONGO_URL);
  const extras = await SowingRequest.find({
    requestNumber: /^SR20261017/,
    notes: /^Cover order from excess/,
  })
    .select("requestNumber notes sowedQuantity")
    .lean();

  console.log(`Extra 17 Oct cover entries: ${extras.length}`);
  let fixed = 0;
  const skipped = [];

  for (const extra of extras) {
    const order = await Order.findOne({ sowingDoneRequestId: extra._id })
      .select("orderId numberOfPlants additionalPlants sowingCoverSources bookingSlot")
      .lean();
    if (!order) {
      skipped.push(`${extra.requestNumber} no order`);
      continue;
    }
    const src = (order.sowingCoverSources || [])[0];
    if (!src?.sowingRequestId || !src?.batchId) {
      skipped.push(`${extra.requestNumber} #${order.orderId} no source`);
      continue;
    }
    const take = n(src.plants) || n(order.numberOfPlants) + n(order.additionalPlants);
    const label = `${extra.requestNumber} #${order.orderId} ${take}`;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (src.moved && src.destBatchId) {
          const dest = await findBatch(src.destBatchId);
          const source = await findBatch(src.batchId);
          if (!dest || !source) {
            throw new Error(`${label} batch missing dest=${!!dest} source=${!!source}`);
          }
          if (n(dest.primarySowed) < take || n(dest.plantsSowed) < take || n(dest.totalPlants) < take) {
            throw new Error(`${label} dest slot ${dest.startDay} sowed ${dest.primarySowed} < ${take}`);
          }
          const actual = n(src.actualPlantsDec);
          const mort = n(src.expectedMortalityDec);
          if (n(dest.actualPlants) < actual || n(dest.expectedMortality) < mort) {
            throw new Error(`${label} dest actual/mort too small`);
          }
          const reservedDec = Math.min(take, n(dest.orderReservedPlants));

          await PlantSlot.updateOne(
            { "subtypeSlots.slots.sowingBatches._id": oid(src.batchId) },
            {
              $inc: {
                [`${SLOT}.primarySowed`]: take,
                [`${SLOT}.plantsSowed`]: take,
                [`${SLOT}.totalPlants`]: take,
                [`${SLOT}.actualPlants`]: actual,
                [`${SLOT}.expectedMortality`]: mort,
                [`${BATCH}.plantsSowed`]: take,
                [`${BATCH}.orderCoveredPlants`]: take,
                [`${BATCH}.actualPlantsApplied`]: n(src.batchActualAppliedDec),
                [`${BATCH}.expectedMortalityApplied`]: n(src.batchMortalityAppliedDec),
              },
              $addToSet: { [`${BATCH}.linkedOrderIds`]: order._id },
            },
            { arrayFilters: filters(source.slotId, src.batchId), session }
          );

          const destInc = {
            [`${SLOT}.primarySowed`]: -take,
            [`${SLOT}.plantsSowed`]: -take,
            [`${SLOT}.totalPlants`]: -take,
            [`${SLOT}.actualPlants`]: -actual,
            [`${SLOT}.expectedMortality`]: -mort,
          };
          if (reservedDec > 0) destInc[`${SLOT}.orderReservedPlants`] = -reservedDec;
          await PlantSlot.updateOne(
            { "subtypeSlots.slots.sowingBatches._id": oid(src.destBatchId) },
            {
              $inc: destInc,
              $pull: {
                [`${SLOT}.sowingBatches`]: { _id: oid(src.destBatchId) },
                [`${SLOT}.linkedSowingRequests`]: extra._id,
              },
            },
            { arrayFilters: filters(dest.slotId, src.destBatchId), session }
          );
          console.log(
            `MOVED ${label} back onto source slot ${source.startDay} (removed entry on ${dest.startDay})`
          );
        } else {
          console.log(`SAME SLOT ${label} cover already on source, drop extra entry`);
        }

        await Order.updateOne(
          { _id: order._id },
          {
            $set: {
              sowingDoneRequestId: src.sowingRequestId,
              "sowingCoverSources.$[c].moved": false,
            },
            $unset: {
              "sowingCoverSources.$[c].destBatchId": "",
              "sowingCoverSources.$[c].destSlotId": "",
            },
          },
          { arrayFilters: [{ "c._id": src._id }], session }
        );
        await SowingRequest.updateOne(
          { _id: src.sowingRequestId },
          { $addToSet: { linkedOrderIds: order._id } },
          { session }
        );
        await PlantSlot.updateMany(
          { "subtypeSlots.slots.linkedSowingRequests": extra._id },
          { $pull: { "subtypeSlots.$[].slots.$[].linkedSowingRequests": extra._id } },
          { session }
        );
        await SowingRequest.deleteOne({ _id: extra._id }, { session });
      });
      fixed += 1;
    } catch (err) {
      skipped.push(`${label} ${err.message}`);
      console.error("SKIP", err.message);
    } finally {
      await session.endSession();
    }
  }

  const left = await SowingRequest.countDocuments({
    requestNumber: /^SR20261017/,
    notes: /^Cover order from excess/,
  });
  console.log(`\nFixed ${fixed}. Still extra: ${left}. Skipped ${skipped.length}`);
  for (const s of skipped) console.log(" -", s);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
