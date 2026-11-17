import "dotenv/config";
import mongoose from "mongoose";

const ORDER_ID = Number(process.argv[2] || 4143);
await mongoose.connect(process.env.MONGO_URL);
const db = mongoose.connection.db;
const o = await db.collection("orders").findOne({ orderId: ORDER_ID });
if (!o) {
  console.log("order not found");
  process.exit(0);
}
const pick = (x, keys) => Object.fromEntries(keys.map((k) => [k, x[k]]));
console.log("ORDER", JSON.stringify(pick(o, [
  "_id", "orderId", "orderStatus", "plantName", "plantSubtype", "numberOfPlants", "additionalPlants",
  "deliveryDate", "bookingSlot", "sowingDone", "sowingDoneAt", "sowingDoneRequestId",
  "sowingCoverSources", "sowingCoverReversedAt", "createdAt", "orderPaymentStatus", "salesPerson", "dealer",
])));
console.log("REMARKS", JSON.stringify((o.orderRemarks || []).slice(-6)));
console.log("STATUS", JSON.stringify((o.statusChanges || []).slice(-6).map((s) => [s.previousStatus, s.newStatus, s.reason, s.createdAt])));

const slotIds = new Set([String(o.bookingSlot)]);
for (const s of o.sowingCoverSources || []) slotIds.add(String(s.slotId));
const docs = await db.collection("plantslots").find({ plantId: o.plantName }, { projection: { year: 1, subtypeSlots: 1 } }).toArray();
for (const d of docs) {
  for (const st of d.subtypeSlots || []) {
    if (String(st.subtypeId) !== String(o.plantSubtype)) continue;
    for (const sl of st.slots || []) {
      const touches = slotIds.has(String(sl._id)) ||
        (sl.sowingBatches || []).some((b) =>
          (b.excessAllocations || []).some((a) => String(a.orderId) === String(o._id)) ||
          (b.linkedOrderIds || []).some((id) => String(id) === String(o._id)) ||
          (b.coveredOrderIds || []).some((id) => String(id) === String(o._id))
        );
      if (!touches) continue;
      console.log(`\nSLOT ${sl._id} ${sl.startDay}→${sl.endDay} booked=${sl.totalBookedPlants} avail=${sl.availablePlants} primarySowed=${sl.primarySowed ?? 0} reserved=${sl.orderReservedPlants ?? 0} excessive=${sl.excessiveSowing?.plants ?? 0}${String(sl._id) === String(o.bookingSlot) ? "  <= BOOKING SLOT" : ""}`);
      for (const b of sl.sowingBatches || []) {
        const mine = (b.excessAllocations || []).filter((a) => String(a.orderId) === String(o._id));
        const linked = (b.linkedOrderIds || []).some((id) => String(id) === String(o._id));
        console.log(`   batch ${b._id} sowed=${b.plantsSowed ?? 0} covered=${b.orderCoveredPlants ?? 0} excess=${b.excessPlants ?? 0} sowing=${b.sowingDate} ready=${b.plantReadyDate} req=${b.requestNumber || ""} transfer=${b.isTransfer || b.transferType || ""}${mine.length ? ` ALLOC_TO_ORDER=${mine.map((a) => a.plants).join("+")}` : ""}${linked ? " LINKED" : ""}`);
      }
      const trail = (sl.slotTrail || []).filter((t) => String(t.orderRef || "") === String(o._id) || t.orderId === ORDER_ID);
      for (const t of trail.slice(-6)) console.log(`   trail ${t.at || t.timestamp} ${t.action} ${t.plants ?? t.quantity ?? ""} ${t.reason || ""}`);
    }
  }
}
if (o.sowingDoneRequestId) {
  const r = await db.collection("sowingrequests").findOne({ _id: o.sowingDoneRequestId });
  console.log("\nAUDIT REQUEST", r && JSON.stringify(pick(r, ["requestNumber", "status", "isTransfer", "transferType", "linkedSlotIds", "sowedQuantity", "notes"])));
}
await mongoose.disconnect();
