import mongoose from "mongoose";
import PlantOutward from "../models/plantOutward.model.js";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantCms from "../models/plantCms.model.js";

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const toInt = (v) => Math.max(0, Math.floor(Number(v) || 0));
const idStr = (v) => (v == null || v === "" ? "" : String(v));

/** YYYY-MM-DD (IST) → [start, end) as UTC Dates, or null. */
export function istDayRange(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || "").trim());
  if (!m) return null;
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * Shed returns reduce the outward line they came from; returns without a source line
 * come off the vehicle's lines of the same batch (+ order when known), in load order.
 */
export function netOutwardPlants(outwards, shedReturnsByDispatch) {
  const left = new Map(outwards.map((o) => [idStr(o.soId), toInt(o.plants)]));
  for (const [dispatchId, returns] of shedReturnsByDispatch) {
    const own = outwards.filter((o) => idStr(o.dispatchId) === dispatchId);
    for (const r of returns || []) {
      let qty = toInt(r.quantity);
      const src = idStr(r.sourceOutwardId);
      const targets = src
        ? own.filter((o) => idStr(o.soId) === src)
        : own.filter(
            (o) =>
              idStr(o.batchId) === idStr(r.batchId) &&
              (!r.orderId || !o.orderId || idStr(o.orderId) === idStr(r.orderId))
          );
      for (const o of targets) {
        if (qty <= 0) break;
        const cur = left.get(idStr(o.soId)) || 0;
        const take = Math.min(cur, qty);
        left.set(idStr(o.soId), cur - take);
        qty -= take;
      }
    }
  }
  return left;
}

/**
 * Flat lines for the day share (one per outward line, net of returns, zero lines dropped).
 * Lookups are Maps keyed by id string.
 */
export function buildDispatchDayLines({ outwards, dispatchById, orderById, batchById, plantNameOf }) {
  const returnsByDispatch = new Map(
    [...dispatchById.entries()].map(([id, d]) => [id, d.shedReturns || []])
  );
  const net = netOutwardPlants(outwards, returnsByDispatch);
  const lines = [];
  for (const o of outwards) {
    const plants = net.get(idStr(o.soId)) || 0;
    if (plants <= 0) continue;
    const d = dispatchById.get(idStr(o.dispatchId));
    if (!d) continue;
    const order = o.orderId ? orderById.get(idStr(o.orderId)) : null;
    const batch = batchById.get(idStr(o.batchId));
    const row = (d.plantsDetails || [])[o.plantRowIndex] || null;
    const names = plantNameOf(
      idStr(batch?.plantCmsId || row?.plantId),
      idStr(batch?.plantSubtypeId || row?.subTypeId)
    );
    lines.push({
      dispatchId: idStr(d._id),
      transportId: d.transportId || "",
      vehicle: d.isInstantPickup
        ? ""
        : [...new Set([d.vehicleName, d.vehicleNumber].map((s) => String(s || "").trim()))]
            .filter(Boolean)
            .join(" · "),
      driverName: d.isInstantPickup ? "" : d.driverName || "",
      isInstantPickup: Boolean(d.isInstantPickup),
      orderId: o.orderId ? idStr(o.orderId) : "",
      orderCode: order ? String(order.publicOrderCode || order.orderId || "") : "",
      farmer: order?.farmer?.name || "",
      village: order?.farmer?.village || "",
      crop: names.plant || String(row?.name || "").split("->")[0].trim(),
      subtype: names.subtype,
      batch: batch?.batchNumber != null ? String(batch.batchNumber) : o.batchNumber || "",
      shed: o.shed || "",
      plants,
      at: o.at || null,
    });
  }
  lines.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  return lines;
}

/** Everything given from sheds on one IST day: vehicles and instant pickups. */
export async function getDispatchDaySummary(day) {
  const range = istDayRange(day);
  if (!range) return null;

  const outwards = await PlantOutward.aggregate([
    {
      $match: {
        secondaryOutward: {
          $elemMatch: {
            linkedDispatchId: { $exists: true, $ne: null },
            secondaryOutwardDate: { $gte: range.start, $lt: range.end },
          },
        },
      },
    },
    { $project: { batchId: 1, secondaryOutward: 1 } },
    { $unwind: "$secondaryOutward" },
    {
      $match: {
        "secondaryOutward.linkedDispatchId": { $exists: true, $ne: null },
        "secondaryOutward.secondaryOutwardDate": { $gte: range.start, $lt: range.end },
      },
    },
    {
      $project: {
        _id: 0,
        batchId: 1,
        soId: "$secondaryOutward._id",
        dispatchId: "$secondaryOutward.linkedDispatchId",
        orderId: "$secondaryOutward.linkedOrderId",
        plants: "$secondaryOutward.totalQuantity",
        shed: "$secondaryOutward.pollyhouse",
        plantRowIndex: "$secondaryOutward.linkedDispatchPlantRowIndex",
        batchNumber: "$secondaryOutward.orderLinkSnapshot.batchNumber",
        at: "$secondaryOutward.secondaryOutwardDate",
      },
    },
  ]);

  const ids = (key) => [
    ...new Set(outwards.map((o) => idStr(o[key])).filter((id) => mongoose.isValidObjectId(id))),
  ];
  const [dispatches, orders, batches] = await Promise.all([
    Dispatch.find({ _id: { $in: ids("dispatchId") }, isDeleted: { $ne: true } })
      .select("transportId vehicleName vehicleNumber driverName isInstantPickup shedReturns plantsDetails")
      .lean(),
    Order.find({ _id: { $in: ids("orderId") } })
      .select("orderId publicOrderCode farmer")
      .populate("farmer", "name village")
      .lean(),
    DispatchBatch.find({ _id: { $in: ids("batchId") } })
      .select("batchNumber plantCmsId plantSubtypeId")
      .lean(),
  ]);

  const plantIds = new Set();
  for (const b of batches) if (b.plantCmsId) plantIds.add(idStr(b.plantCmsId));
  for (const d of dispatches) {
    for (const p of d.plantsDetails || []) if (p.plantId) plantIds.add(idStr(p.plantId));
  }
  const cms = await PlantCms.find({
    _id: { $in: [...plantIds].filter((id) => mongoose.isValidObjectId(id)) },
  })
    .select("name subtypes._id subtypes.name")
    .lean();
  const cmsById = new Map(cms.map((p) => [idStr(p._id), p]));
  const plantNameOf = (plantId, subtypeId) => {
    const p = cmsById.get(plantId);
    return {
      plant: p?.name || "",
      subtype: (p?.subtypes || []).find((s) => idStr(s._id) === subtypeId)?.name || "",
    };
  };

  const lines = buildDispatchDayLines({
    outwards,
    dispatchById: new Map(dispatches.map((d) => [idStr(d._id), d])),
    orderById: new Map(orders.map((o) => [idStr(o._id), o])),
    batchById: new Map(batches.map((b) => [idStr(b._id), b])),
    plantNameOf,
  });

  const vehicles = new Set(lines.filter((l) => !l.isInstantPickup).map((l) => l.dispatchId));
  const pickups = new Set(lines.filter((l) => l.isInstantPickup).map((l) => l.dispatchId));
  return {
    date: day,
    lines,
    totals: {
      plants: lines.reduce((s, l) => s + l.plants, 0),
      vehicles: vehicles.size,
      pickups: pickups.size,
      orders: new Set(lines.map((l) => l.orderId).filter(Boolean)).size,
    },
  };
}
