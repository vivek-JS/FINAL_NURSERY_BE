/**
 * Finish #4257 on SR202610240003 from mortality leftover (4965 of 12277).
 *   node scripts/fix-4257-complete-from-buffer-prod.mjs --apply
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import { pushBatchChangeLog } from "../utility/sowingBatchChangeLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });
const APPLY = process.argv.includes("--apply");
const REQ = "SR202610240003";
const COVER = 95000;

async function main() {
  await mongoose.connect(process.env.PROD_MONGO_URL);
  const req = await SowingRequest.findOne({ requestNumber: REQ });
  const rid = req._id;
  const o4257 = await Order.findOne({ orderId: 4257 }).select(
    "_id orderId sowingDone sowingPartialCover leftoverFromIncomplete"
  );
  console.log(
    `${REQ} #4257 done=${o4257.sowingDone} hold=${JSON.stringify(o4257.sowingPartialCover || [])}`
  );
  if (!APPLY) {
    await mongoose.disconnect();
    return;
  }
  await Order.updateOne(
    { _id: o4257._id },
    {
      $set: {
        sowingDone: true,
        leftoverFromIncomplete: false,
        sowingDoneRequestId: rid,
        sowingDoneAt: req.sowingCompletedDate || new Date(),
      },
      $pull: { sowingPartialCover: { requestId: rid } },
    }
  );
  const linked = [...new Set([...(req.linkedOrderIds || []).map(String), String(o4257._id)])];
  req.linkedOrderIds = linked;
  req.uncoveredOrderIds = (req.uncoveredOrderIds || []).filter(
    (id) => String(id) !== String(o4257._id)
  );
  req.markModified("linkedOrderIds");
  req.markModified("uncoveredOrderIds");
  await req.save();

  const [slotRow] = await mongoose.connection.db
    .collection("plantslots")
    .aggregate([
      { $match: { "subtypeSlots.slots.sowingBatches.sowingRequestId": rid } },
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      { $unwind: "$subtypeSlots.slots.sowingBatches" },
      { $match: { "subtypeSlots.slots.sowingBatches.sowingRequestId": rid } },
      {
        $project: {
          slotId: "$subtypeSlots.slots._id",
          batch: "$subtypeSlots.slots.sowingBatches",
        },
      },
    ])
    .toArray();
  if (slotRow) {
    const batch = slotRow.batch;
    pushBatchChangeLog(batch, {
      kind: "COVER_FILL",
      plants: 4965,
      coverBefore: batch.orderCoveredPlants,
      coverAfter: COVER,
      reason: "#4257 finished from mortality leftover 4965",
    });
    await mongoose.connection.db.collection("plantslots").updateOne(
      {
        _id: slotRow._id,
        "subtypeSlots.slots._id": slotRow.slotId,
        "subtypeSlots.slots.sowingBatches.sowingRequestId": rid,
      },
      {
        $set: {
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].orderCoveredPlants": COVER,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].changeLog": batch.changeLog,
        },
      },
      {
        arrayFilters: [
          { "st.slots._id": slotRow.slotId },
          { "sl._id": slotRow.slotId },
          { "b.sowingRequestId": rid },
        ],
      }
    );
  }
  console.log("applied cover", COVER);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
