/**
 * Dry run: batch-wise available plants + sold (ledger LOAD) with order links.
 * Usage: node scripts/dry-run-batch-available-sold.js [startDay] [endDay] [slotId?]
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

import PlantSlot from "../models/slots.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import Order from "../models/order.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import "../models/farmer.model.js";

const LOAD = "LOAD";
const LINES = "secondarydispatchledgerlines";

const startDayArg = process.argv[2] || "03-09-2026";
const endDayArg = process.argv[3] || "09-09-2026";
const slotIdArg = process.argv[4] || null;

function fmt(n) {
  return Math.max(0, Math.floor(Number(n) || 0)).toLocaleString("en-IN");
}

async function runForSlot(slotId, slotMeta, plantLabel) {
  const startDay = slotMeta.startDay;
  const endDay = slotMeta.endDay;

  console.log("\n=== DRY RUN: Batch available vs sold (order-linked) ===");
  console.log(`Plant: ${plantLabel}`);
  console.log(`Slot: ${startDay} – ${endDay}`);
  console.log(`Slot _id: ${slotId}`);
  console.log(`actualReadyPlants (slot): ${fmt(slotMeta?.actualReadyPlants)}`);
  console.log(`actualPlants (slot): ${fmt(slotMeta?.actualPlants)}\n`);

  const slotOid = new mongoose.Types.ObjectId(slotId);
  const pos = await PlantOutward.find({
    "secondaryInward.linkedBookingSlotId": slotOid,
  })
    .populate({ path: "batchId", select: "batchNumber" })
    .lean();

  const batchMap = new Map();
  const inwardIds = [];

  for (const po of pos) {
    const batchLean = po.batchId && typeof po.batchId === "object" ? po.batchId : null;
    const batchNumber = batchLean?.batchNumber ?? String(po.batchId || "—");
    const batchIdStr = batchLean?._id ? String(batchLean._id) : String(po.batchId || "");

    for (const si of po.secondaryInward || []) {
      if (String(si.linkedBookingSlotId) !== slotId) continue;
      const inwardId = si._id ? String(si._id) : null;
      if (inwardId) inwardIds.push(inwardId);

      const avail = Math.max(0, Number(si.availableQuantity) || 0);
      const synced = Math.max(0, Number(si.slotStockSyncedPlants) || 0);
      const shed = si.pollyhouse || po.pollyhouse || "—";

      if (!batchMap.has(batchNumber)) {
        batchMap.set(batchNumber, {
          batchNumber,
          batchId: batchIdStr,
          availableInShed: 0,
          syncedToSlot: 0,
          lines: [],
        });
      }
      const g = batchMap.get(batchNumber);
      g.availableInShed += avail;
      g.syncedToSlot += synced;
      g.lines.push({ inwardId, shed, available: avail, synced });
    }
  }

  const orders = await Order.find({ bookingSlot: slotOid })
    .select("_id orderId numberOfPlants orderStatus farmer")
    .populate("farmer", "name")
    .lean();
  const orderIds = orders.map((o) => String(o._id));
  const orderById = new Map(orders.map((o) => [String(o._id), o]));

  const missingOrderIds = new Set();
  const linesCol = mongoose.connection.collection(LINES);
  const or = [];
  if (orderIds.length) {
    or.push({ linkedOrderId: { $in: orderIds } });
    or.push({
      linkedOrderId: {
        $in: orderIds.map((id) => new mongoose.Types.ObjectId(id)),
      },
    });
  }
  if (inwardIds.length) or.push({ secondaryInwardId: { $in: inwardIds } });

  let ledgerLines = or.length
    ? await linesCol.find({ action: LOAD, $or: or }).sort({ createdAt: -1 }).toArray()
    : [];

  for (const ln of ledgerLines) {
    const oid = ln.linkedOrderId ? String(ln.linkedOrderId) : null;
    if (oid && !orderById.has(oid)) missingOrderIds.add(oid);
  }
  if (missingOrderIds.size) {
    const extra = await Order.find({
      _id: {
        $in: [...missingOrderIds].map((id) => new mongoose.Types.ObjectId(id)),
      },
    })
      .select("_id orderId farmer")
      .populate("farmer", "name")
      .lean();
    for (const o of extra) orderById.set(String(o._id), o);
  }

  const soldByBatch = new Map();
  const orderLinks = [];

  for (const ln of ledgerLines) {
    const bn = ln.batchNumber || "—";
    const qty = Math.max(0, Number(ln.plantsAbs) || 0);
    soldByBatch.set(bn, (soldByBatch.get(bn) || 0) + qty);

    const order = ln.linkedOrderId ? orderById.get(String(ln.linkedOrderId)) : null;
    orderLinks.push({
      batchNumber: bn,
      sold: qty,
      orderNumber: order?.orderId ?? ln.linkedOrderId ?? "—",
      farmer:
        order?.farmer && typeof order.farmer === "object"
          ? order.farmer.name
          : "—",
      shed: ln.pollyhouse ?? ln.metadata?.pollyhouse ?? "—",
      when: ln.createdAt ?? "—",
    });
  }

  const allBatchNumbers = new Set([...batchMap.keys(), ...soldByBatch.keys()]);

  console.log("--- BATCH SUMMARY ---");
  console.log(
    [
      "Batch".padEnd(22),
      "Avail(shed)".padStart(12),
      "Synced(slot)".padStart(12),
      "Sold(out)".padStart(12),
      "Remain*".padStart(12),
    ].join(" ")
  );
  console.log("-".repeat(72));

  let totAvail = 0;
  let totSynced = 0;
  let totSold = 0;

  for (const bn of [...allBatchNumbers].sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true })
  )) {
    const b = batchMap.get(bn) || { availableInShed: 0, syncedToSlot: 0 };
    const sold = soldByBatch.get(bn) || 0;
    totAvail += b.availableInShed;
    totSynced += b.syncedToSlot;
    totSold += sold;

    console.log(
      [
        String(bn).padEnd(22),
        fmt(b.availableInShed).padStart(12),
        fmt(b.syncedToSlot).padStart(12),
        fmt(sold).padStart(12),
        fmt(Math.max(0, b.syncedToSlot - sold)).padStart(12),
      ].join(" ")
    );
  }

  console.log("-".repeat(72));
  console.log(
    [
      "TOTAL".padEnd(22),
      fmt(totAvail).padStart(12),
      fmt(totSynced).padStart(12),
      fmt(totSold).padStart(12),
      fmt(Math.max(0, totSynced - totSold)).padStart(12),
    ].join(" ")
  );
  console.log("*Remain = syncedToSlot − sold (ledger LOAD)\n");

  console.log("--- ORDER LINK TABLE (sold / ledger LOAD) ---");
  console.log(
    [
      "Batch".padEnd(20),
      "Order".padStart(8),
      "Farmer".padEnd(24),
      "Shed".padEnd(12),
      "Sold".padStart(8),
      "When".padEnd(18),
    ].join(" ")
  );
  console.log("-".repeat(95));

  if (!orderLinks.length) {
    console.log("(no ledger LOAD lines for this slot's batches/orders)");
  } else {
    let orderSoldTotal = 0;
    for (const row of orderLinks) {
      orderSoldTotal += Number(row.sold) || 0;
      const when =
        row.when && row.when !== "—"
          ? new Date(row.when).toISOString().slice(0, 16).replace("T", " ")
          : "—";
      console.log(
        [
          String(row.batchNumber).padEnd(20),
          String(row.orderNumber).padStart(8),
          String(row.farmer).slice(0, 22).padEnd(24),
          String(row.shed).slice(0, 10).padEnd(12),
          fmt(row.sold).padStart(8),
          when.padEnd(18),
        ].join(" ")
      );
    }
    console.log("-".repeat(95));
    console.log(
      [
        "TOTAL".padEnd(20),
        "".padStart(8),
        "".padEnd(24),
        "".padEnd(12),
        fmt(orderSoldTotal).padStart(8),
        "".padEnd(18),
      ].join(" ")
    );
  }

  console.log(`\nOrders on booking slot: ${orders.length}`);
  console.log(`Ledger LOAD lines: ${ledgerLines.length}`);
  console.log(`Secondary inward lines on slot: ${inwardIds.length}`);
}

async function main() {
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("No MONGO_URL in env");
  await mongoose.connect(uri);

  if (slotIdArg && mongoose.isValidObjectId(slotIdArg)) {
    const plantSlotDoc = await PlantSlot.findOne({
      "subtypeSlots.slots._id": new mongoose.Types.ObjectId(slotIdArg),
    })
      .select("plantId subtypeSlots")
      .lean();
    if (!plantSlotDoc) {
      console.error(`No plant slot doc for slot id ${slotIdArg}`);
      process.exit(1);
    }
    let slotMeta = null;
    for (const st of plantSlotDoc.subtypeSlots || []) {
      const found = (st.slots || []).find((s) => String(s._id) === slotIdArg);
      if (found) {
        slotMeta = found;
        break;
      }
    }
    await runForSlot(slotIdArg, slotMeta, String(plantSlotDoc.plantId));
    await mongoose.disconnect();
    return;
  }

  const docs = await PlantSlot.find({
    "subtypeSlots.slots.startDay": startDayArg,
    "subtypeSlots.slots.endDay": endDayArg,
  })
    .select("plantId subtypeSlots")
    .lean();

  if (!docs.length) {
    console.error(`No slot found for ${startDayArg} – ${endDayArg}`);
    process.exit(1);
  }

  const matches = [];
  for (const doc of docs) {
    for (const st of doc.subtypeSlots || []) {
      for (const sl of st.slots || []) {
        if (sl.startDay === startDayArg && sl.endDay === endDayArg) {
          matches.push({
            slotId: String(sl._id),
            slotMeta: sl,
            plantLabel: String(doc.plantId),
          });
        }
      }
    }
  }

  console.log(`Found ${matches.length} slot(s) for ${startDayArg} – ${endDayArg}`);
  for (const m of matches) {
    await runForSlot(m.slotId, m.slotMeta, m.plantLabel);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
