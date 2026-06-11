import Order from "../../../models/order.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
} from "../../../utility/istOrderDateStats.js";

function slotDateSortKey(slot) {
  if (!slot || typeof slot !== "object") return null;
  const y = Number(slot.year) || 0;
  const m = String(slot.month || "");
  const d = String(slot.startDay || slot.endDay || "01");
  const months = {
    January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
    July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
  };
  const mi = months[m] || parseInt(m, 10) || 0;
  const di = parseInt(d, 10) || 0;
  return y * 10000 + mi * 100 + di;
}

function classifyChangeDirection(prev, next) {
  const p = slotDateSortKey(prev);
  const n = slotDateSortKey(next);
  if (p == null || n == null) return "sameWindow";
  if (n < p) return "early";
  if (n > p) return "late";
  return "sameWindow";
}

/**
 * Delivery change summary for CEO report (IST range on change createdAt).
 */
export async function aggregateDeliveryChangeSummary(rangeStart, rangeEnd, extraMatch = {}) {
  const base = { ...orderStatusExcludeMatch(), ...extraMatch };

  const [changeRows, earlyDispatchRow, reasonRows] = await Promise.all([
    Order.aggregate([
      { $match: base },
      { $unwind: "$deliveryChanges" },
      {
        $match: {
          "deliveryChanges.createdAt": { $gte: rangeStart, $lte: rangeEnd },
        },
      },
      {
        $addFields: {
          _direction: {
            $literal: "pending",
          },
          linePlantTotal: {
            $add: [
              { $ifNull: ["$numberOfPlants", 0] },
              { $ifNull: ["$additionalPlants", 0] },
            ],
          },
        },
      },
      {
        $project: {
          orderId: "$_id",
          farmer: 1,
          orderFor: 1,
          linePlantTotal: 1,
          previousDeliveryDate: "$deliveryChanges.previousDeliveryDate",
          newDeliveryDate: "$deliveryChanges.newDeliveryDate",
          reasonForChange: "$deliveryChanges.reasonForChange",
        },
      },
    ]),
    Order.aggregate([
      {
        $match: {
          ...base,
          dispatchedFromAnotherSlot: true,
          deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
        },
      },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          farmers: { $addToSet: { $ifNull: ["$farmer", "$orderFor.name"] } },
          plants: { $sum: "$linePlantTotal" },
        },
      },
    ]),
    Order.aggregate([
      { $match: base },
      { $unwind: "$deliveryChanges" },
      {
        $match: {
          "deliveryChanges.createdAt": { $gte: rangeStart, $lte: rangeEnd },
        },
      },
      {
        $group: {
          _id: "$deliveryChanges.reasonForChange",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]),
  ]);

  const byDirection = {
    early: { orders: 0, farmers: new Set(), plants: 0, changeEvents: 0 },
    late: { orders: 0, farmers: new Set(), plants: 0, changeEvents: 0 },
    sameWindow: { orders: 0, farmers: new Set(), plants: 0, changeEvents: 0 },
  };
  const orderIds = new Set();
  const farmerIds = new Set();

  for (const row of changeRows) {
    const dir = classifyChangeDirection(
      row.previousDeliveryDate,
      row.newDeliveryDate
    );
    byDirection[dir].changeEvents += 1;
    const oid = String(row.orderId);
    if (!orderIds.has(oid)) {
      orderIds.add(oid);
      byDirection[dir].orders += 1;
      byDirection[dir].plants += row.linePlantTotal || 0;
    }
    const fid = row.farmer ? String(row.farmer) : row.orderFor?.name || oid;
    byDirection[dir].farmers.add(fid);
    farmerIds.add(fid);
  }

  const formatDir = (d) => ({
    orders: d.orders,
    farmers: d.farmers.size,
    plants: d.plants,
    changeEvents: d.changeEvents,
  });

  const earlyDispatch = earlyDispatchRow[0] || { orders: 0, plants: 0, farmers: [] };

  return {
    totalChanges: {
      orders: orderIds.size,
      farmers: farmerIds.size,
      changeEvents: changeRows.length,
    },
    byDirection: {
      early: formatDir(byDirection.early),
      late: formatDir(byDirection.late),
      sameWindow: formatDir(byDirection.sameWindow),
    },
    earlyDispatch: {
      orders: earlyDispatch.orders ?? 0,
      farmers: Array.isArray(earlyDispatch.farmers) ? earlyDispatch.farmers.length : 0,
      plants: earlyDispatch.plants ?? 0,
      description: "Cross-slot / early dispatch (dispatchedFromAnotherSlot)",
    },
    topReasons: (reasonRows || []).map((r) => ({
      reason: r._id || "Unknown",
      count: r.count,
    })),
    drill: {
      allChanges: { bucket: "deliveryChanged" },
      earlyOnly: { bucket: "earlyDelivery" },
      lateOnly: { bucket: "deliveryChanged", changeDirection: "late" },
    },
  };
}

export function deliveryChangedMatch(rangeStart, rangeEnd) {
  return {
    ...orderStatusExcludeMatch(),
    deliveryChanges: {
      $elemMatch: { createdAt: { $gte: rangeStart, $lte: rangeEnd } },
    },
  };
}

export function earlyDeliveryMatch(rangeStart, rangeEnd) {
  return {
    ...orderStatusExcludeMatch(),
    $or: [
      {
        dispatchedFromAnotherSlot: true,
        deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
      },
      {
        deliveryChanges: {
          $elemMatch: { createdAt: { $gte: rangeStart, $lte: rangeEnd } },
        },
      },
    ],
  };
}
