/**
 * Dry run only. Dispatched orders that have a batch and a shed, but are not completed.
 * Shows the plants that would leave the batch, and whether that stock is already gone.
 *
 *   node scripts/dry-run-dispatched-batch-complete.mjs
 */
import "dotenv/config";
import mongoose from "mongoose";

const OPEN = ["DISPATCHED", "PARTIALLY_COMPLETED", "DISPATCH_PROCESS"];

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function idStr(v) {
  if (v == null) return "";
  return String(v._id || v);
}

function norm(v) {
  return v == null ? "" : String(v).trim();
}

async function main() {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!uri) {
    console.error("PROD_MONGO_URL is not set");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log("db", mongoose.connection.name);

  const orders = await db
    .collection("orders")
    .find(
      { orderStatus: { $in: OPEN } },
      {
        projection: {
          orderId: 1,
          orderStatus: 1,
          numberOfPlants: 1,
          additionalPlants: 1,
          remainingPlants: 1,
          returnedPlants: 1,
          damagedPlants: 1,
          batchNumber: 1,
          deliveryCompleteBatch: 1,
        },
      }
    )
    .toArray();

  const orderById = new Map(orders.map((o) => [String(o._id), o]));
  const orderIds = orders.map((o) => o._id);
  console.log("open dispatched-like orders", orders.length);

  const dispatches = await db
    .collection("dispatches")
    .find(
      { isDeleted: { $ne: true }, orderIds: { $in: orderIds } },
      {
        projection: {
          transportId: 1,
          orderIds: 1,
          orderDispatchDetails: 1,
          plantsDetails: 1,
        },
      }
    )
    .toArray();

  const lines = [];
  for (const d of dispatches) {
    const details = Array.isArray(d.orderDispatchDetails) ? d.orderDispatchDetails : [];
    for (const det of details) {
      const oid = idStr(det.orderId);
      const order = orderById.get(oid);
      if (!order) continue;
      const loaded = Array.isArray(det.shedLoadedBatches) ? det.shedLoadedBatches : [];
      for (const b of loaded) {
        const batchNumber = norm(b.batchNumber);
        const shed = norm(b.pollyhouse);
        if (!batchNumber || !shed) continue;
        lines.push({
          orderMongoId: oid,
          orderId: order.orderId,
          orderStatus: order.orderStatus,
          transportId: d.transportId || "",
          dispatchId: String(d._id),
          source: "shed_load",
          batchId: idStr(b.batchId),
          batchNumber,
          shed,
          secondaryInwardId: idStr(b.secondaryInwardId),
          plants: n(b.plants) || n(det.shedLoadedQuantity) || n(det.dispatchQuantity),
        });
      }
    }

    const plantRows = Array.isArray(d.plantsDetails) ? d.plantsDetails : [];
    for (const row of plantRows) {
      const pickups = Array.isArray(row.pickupDetails) ? row.pickupDetails : [];
      for (const p of pickups) {
        const batchNumber = norm(p.batchNumber);
        const shed = norm(p.pollyhouseMatched);
        if (!batchNumber || !shed) continue;
        const related = (d.orderIds || []).map(idStr).filter((id) => orderById.has(id));
        for (const oid of related) {
          const order = orderById.get(oid);
          const already = lines.some(
            (l) =>
              l.orderMongoId === oid &&
              l.dispatchId === String(d._id) &&
              l.batchNumber === batchNumber &&
              l.shed === shed
          );
          if (already) continue;
          const det = details.find((x) => idStr(x.orderId) === oid);
          lines.push({
            orderMongoId: oid,
            orderId: order.orderId,
            orderStatus: order.orderStatus,
            transportId: d.transportId || "",
            dispatchId: String(d._id),
            source: "pickup",
            batchId: idStr(p.batchId),
            batchNumber,
            shed,
            secondaryInwardId: idStr(p.secondaryInwardId),
            plants: n(p.quantity) || n(det?.dispatchQuantity) || n(order.numberOfPlants) + n(order.additionalPlants),
          });
        }
      }
    }
  }

  console.log("batch+shed lines on open orders", lines.length);

  const outwards = await db
    .collection("plantoutwards")
    .find(
      { "secondaryOutward.linkedOrderId": { $in: orderIds } },
      {
        projection: {
          batchId: 1,
          "secondaryOutward.linkedOrderId": 1,
          "secondaryOutward.linkedDispatchId": 1,
          "secondaryOutward.totalQuantity": 1,
          "secondaryOutward.numberOfPlants": 1,
          "secondaryOutward.pollyhouse": 1,
          "secondaryOutward.sourceSecondaryInwardId": 1,
        },
      }
    )
    .toArray();

  const outwardByOrder = new Map();
  for (const po of outwards) {
    for (const row of po.secondaryOutward || []) {
      const oid = idStr(row.linkedOrderId);
      if (!oid) continue;
      const list = outwardByOrder.get(oid) || [];
      list.push({
        batchId: idStr(po.batchId),
        dispatchId: idStr(row.linkedDispatchId),
        plants: n(row.totalQuantity) || n(row.numberOfPlants),
        shed: norm(row.pollyhouse),
        inwardId: idStr(row.sourceSecondaryInwardId),
      });
      outwardByOrder.set(oid, list);
    }
  }

  const batchIds = [
    ...new Set(lines.map((l) => l.batchId).filter((id) => mongoose.isValidObjectId(id))),
  ].map((id) => new mongoose.Types.ObjectId(id));
  const batchNumbers = [...new Set(lines.map((l) => l.batchNumber))];

  const stockDocs = await db
    .collection("plantoutwards")
    .find(
      {
        $or: [
          ...(batchIds.length ? [{ batchId: { $in: batchIds } }] : []),
          { "secondaryInward.batchNumber": { $in: batchNumbers } },
        ],
      },
      {
        projection: {
          batchId: 1,
          "secondaryInward._id": 1,
          "secondaryInward.availableQuantity": 1,
          "secondaryInward.pollyhouse": 1,
          "secondaryInward.batchNumber": 1,
        },
      }
    )
    .toArray();

  const batches = await db
    .collection("dispatchbatches")
    .find(
      {
        $or: [
          ...(batchIds.length ? [{ _id: { $in: batchIds } }] : []),
          { batchNumber: { $in: batchNumbers } },
        ],
      },
      { projection: { batchNumber: 1 } }
    )
    .toArray();
  const batchNoById = new Map(batches.map((b) => [String(b._id), b.batchNumber]));

  function stockFor(line) {
    for (const po of stockDocs) {
      if (line.batchId && idStr(po.batchId) !== line.batchId) continue;
      if (!line.batchId && batchNoById.get(idStr(po.batchId)) !== line.batchNumber) continue;
      for (const si of po.secondaryInward || []) {
        if (line.secondaryInwardId && idStr(si._id) === line.secondaryInwardId) {
          return { avail: n(si.availableQuantity), shed: norm(si.pollyhouse), inwardId: idStr(si._id), batchId: idStr(po.batchId) };
        }
      }
    }
    for (const po of stockDocs) {
      const bn = batchNoById.get(idStr(po.batchId)) || "";
      if (line.batchId && idStr(po.batchId) !== line.batchId && bn !== line.batchNumber) continue;
      if (!line.batchId && bn !== line.batchNumber) continue;
      for (const si of po.secondaryInward || []) {
        if (norm(si.pollyhouse) === line.shed) {
          return { avail: n(si.availableQuantity), shed: norm(si.pollyhouse), inwardId: idStr(si._id), batchId: idStr(po.batchId) };
        }
      }
    }
    return null;
  }

  const pending = [];
  const already = [];
  for (const line of lines) {
    const outs = (outwardByOrder.get(line.orderMongoId) || []).filter((o) => {
      if (line.dispatchId && o.dispatchId && o.dispatchId !== line.dispatchId) return false;
      if (line.batchId && o.batchId && o.batchId !== line.batchId) return false;
      return true;
    });
    const deducted = outs.reduce((s, o) => s + o.plants, 0);
    const row = { ...line, alreadyDeducted: deducted, stock: stockFor(line) };
    if (deducted > 0) already.push(row);
    else pending.push(row);
  }

  const byBatch = new Map();
  for (const row of pending) {
    const key = `${row.batchNumber} | ${row.shed}`;
    const cur = byBatch.get(key) || { batchNumber: row.batchNumber, shed: row.shed, plants: 0, orders: [], avail: row.stock?.avail ?? null };
    cur.plants += row.plants;
    cur.orders.push(row.orderId);
    if (cur.avail == null && row.stock) cur.avail = row.stock.avail;
    byBatch.set(key, cur);
  }

  console.log("\nALREADY TAKEN OFF THE BATCH (load outward exists) — complete would not subtract again");
  console.log("orders", new Set(already.map((r) => r.orderId)).size, "lines", already.length);
  console.log("plants already out", already.reduce((s, r) => s + r.alreadyDeducted, 0));

  console.log("\nNOT YET TAKEN OFF THE BATCH — dry run would subtract, then complete");
  console.log("orders", new Set(pending.map((r) => r.orderId)).size, "lines", pending.length);
  console.log("plants to subtract", pending.reduce((s, r) => s + r.plants, 0));

  const groups = [...byBatch.values()].sort((a, b) => b.plants - a.plants);
  console.log("\nbatch | shed | subtract | available now | after | orders");
  for (const g of groups) {
    const after = g.avail == null ? "no line" : g.avail - g.plants;
    const short = g.avail != null && g.avail < g.plants ? " SHORT" : "";
    console.log(
      `${g.batchNumber} | ${g.shed} | ${g.plants} | ${g.avail ?? "—"} | ${after}${short} | ${g.orders.join(",")}`
    );
  }

  console.log("\nline detail (not yet subtracted)");
  for (const row of pending.sort((a, b) => String(a.orderId).localeCompare(String(b.orderId)))) {
    console.log(
      `#${row.orderId} ${row.orderStatus} ${row.source} batch=${row.batchNumber} shed=${row.shed} plants=${row.plants} avail=${row.stock?.avail ?? "—"} transport=${row.transportId}`
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
