import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const ORDER_ID = Number(process.argv[2] || 3567);

await mongoose.connect(
  process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_URI
);

const Order = (await import("../models/order.model.js")).default;
const PlantSlot = (await import("../models/slots.model.js")).default;
const SowingRequest = (await import("../models/sowingRequest.model.js")).default;

const order = await Order.findOne({ orderId: ORDER_ID }).lean();
if (!order) {
  console.log(JSON.stringify({ found: false, message: `Order ${ORDER_ID} not found` }));
  await mongoose.disconnect();
  process.exit(0);
}

const orderKey = order._id.toString();
const bookingSlot = order.bookingSlot
  ? await PlantSlot.findById(order.bookingSlot)
      .select(
        "startDay endDay plantId subtypeId sowingBatches gapCovered gapFullyCovered"
      )
      .lean()
  : null;

const batches = await PlantSlot.find({ "sowingBatches.linkedOrderIds": order._id })
  .select("startDay endDay sowingBatches plantId subtypeId")
  .lean();

const srByOrder = await SowingRequest.find({ linkedOrderIds: order._id })
  .select(
    "requestNumber status sowingCompleted plantReadyDate slotId sowedQuantity linkedOrderIds"
  )
  .lean();

const plants =
  (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0);

const inLocalBatch = (bookingSlot?.sowingBatches || []).some((b) =>
  (b.linkedOrderIds || []).some((id) => id.toString() === orderKey)
);

const out = {
  found: true,
  orderId: order.orderId,
  orderStatus: order.orderStatus,
  sowingDone: Boolean(order.sowingDone),
  sowingDoneAt: order.sowingDoneAt || null,
  sowingDoneRequestId: order.sowingDoneRequestId?.toString?.() || null,
  plants,
  deliveryDate: order.deliveryDate,
  plantName: order.plantName,
  plantSubtype: order.plantSubtype,
  bookingSlotId: order.bookingSlot?.toString?.() || null,
  bookingSlotWindow: bookingSlot
    ? `${bookingSlot.startDay} - ${bookingSlot.endDay}`
    : null,
  bookingSlotGapCovered: bookingSlot?.gapCovered || [],
  bookingSlotGapFullyCovered: Boolean(bookingSlot?.gapFullyCovered),
  inLocalSowingBatchOnBookingSlot: inLocalBatch,
  inSowingBatchesOnOtherSlots: batches
    .filter((s) => s._id.toString() !== (order.bookingSlot?.toString?.() || ""))
    .map((s) => ({
      slotId: s._id.toString(),
      window: `${s.startDay} - ${s.endDay}`,
      batches: (s.sowingBatches || [])
        .filter((b) =>
          (b.linkedOrderIds || []).some((id) => id.toString() === orderKey)
        )
        .map((b) => ({
          requestNumber: b.requestNumber,
          plantReadyDate: b.plantReadyDate,
          quantity: b.quantity || b.sowedQuantity,
        })),
    })),
  sowingRequests: srByOrder.map((r) => ({
    requestNumber: r.requestNumber,
    status: r.status,
    sowingCompleted: r.sowingCompleted,
    plantReadyDate: r.plantReadyDate,
    slotId: r.slotId?.toString?.(),
    sowedQuantity: r.sowedQuantity,
  })),
  verdict: null,
};

if (order.sowingDone) {
  if (inLocalBatch) {
    out.verdict = "SOWING COVERED — sowingDone=true, linked on same booking slot batch";
  } else if (out.inSowingBatchesOnOtherSlots.length > 0) {
    out.verdict =
      "SOWING COVERED — sowingDone=true, sowed on another slot's ready window";
  } else if ((bookingSlot?.gapCovered || []).length > 0) {
    out.verdict =
      "SOWING COVERED (slot-level gapCovered) — sowingDone=true but not in linkedOrderIds";
  } else {
    out.verdict =
      "SOWING MARKED DONE — sowingDone=true but no batch link found (check sowingDoneRequestId)";
  }
} else {
  out.verdict = "NOT SOWING COVERED — sowingDone=false";
}

console.log(JSON.stringify(out, null, 2));
await mongoose.disconnect();
