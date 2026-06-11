import Dispatch from "../../../models/dispatch.model.js";

const IST = "Asia/Kolkata";

export function dispatchDateMatch(rangeStart, rangeEnd) {
  return {
    isDeleted: { $ne: true },
    createdAt: { $gte: rangeStart, $lte: rangeEnd },
  };
}

export const DISPATCH_PLANT_QTY_FIELD = {
  _plantQty: {
    $let: {
      vars: {
        fromOrders: {
          $sum: {
            $map: {
              input: { $ifNull: ["$orderDispatchDetails", []] },
              as: "od",
              in: { $ifNull: ["$$od.dispatchQuantity", 0] },
            },
          },
        },
        fromPlants: {
          $sum: {
            $map: {
              input: { $ifNull: ["$plantsDetails", []] },
              as: "pd",
              in: { $ifNull: ["$$pd.quantity", { $ifNull: ["$$pd.totalPlants", 0] }] },
            },
          },
        },
      },
      in: {
        $cond: [{ $gt: ["$$fromOrders", 0] }, "$$fromOrders", "$$fromPlants"],
      },
    },
  },
};

export const DISPATCH_ORDER_COUNT_FIELD = {
  _orderCount: { $size: { $ifNull: ["$orderIds", []] } },
};

export const DISPATCH_CRATE_COUNT_FIELD = {
  _crateCount: {
    $sum: {
      $map: {
        input: { $ifNull: ["$plantsDetails", []] },
        as: "pd",
        in: {
          $sum: {
            $map: {
              input: { $ifNull: ["$$pd.crates", []] },
              as: "cr",
              in: { $ifNull: ["$$cr.crateCount", 0] },
            },
          },
        },
      },
    },
  },
};

function periodKeyExpr(granularity) {
  if (granularity === "month") {
    return {
      $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: IST },
    };
  }
  return {
    $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: IST },
  };
}

export async function aggregateFleetSummary(rangeStart, rangeEnd) {
  const [row] = await Dispatch.aggregate([
    { $match: dispatchDateMatch(rangeStart, rangeEnd) },
    { $addFields: { ...DISPATCH_PLANT_QTY_FIELD, ...DISPATCH_ORDER_COUNT_FIELD, ...DISPATCH_CRATE_COUNT_FIELD } },
    {
      $group: {
        _id: null,
        trips: { $sum: 1 },
        plants: { $sum: "$_plantQty" },
        orders: { $sum: "$_orderCount" },
        crates: { $sum: "$_crateCount" },
        returnedPlants: { $sum: { $ifNull: ["$returnedPlants", 0] } },
        damagedPlants: { $sum: { $ifNull: ["$damagedPlants", 0] } },
        delivered: {
          $sum: { $cond: [{ $eq: ["$transportStatus", "DELIVERED"] }, 1, 0] },
        },
        inTransit: {
          $sum: { $cond: [{ $eq: ["$transportStatus", "IN_TRANSIT"] }, 1, 0] },
        },
        loaded: {
          $sum: { $cond: [{ $eq: ["$transportStatus", "LOADED"] }, 1, 0] },
        },
        pending: {
          $sum: { $cond: [{ $eq: ["$transportStatus", "PENDING"] }, 1, 0] },
        },
        cancelled: {
          $sum: { $cond: [{ $eq: ["$transportStatus", "CANCELLED"] }, 1, 0] },
        },
        completedTrips: {
          $sum: { $cond: [{ $eq: ["$tripId", null] }, 0, 1] },
        },
        drivers: { $addToSet: "$driverName" },
        vehicles: { $addToSet: "$vehicleNumber" },
      },
    },
    {
      $project: {
        _id: 0,
        trips: 1,
        plants: 1,
        orders: 1,
        crates: 1,
        returnedPlants: 1,
        damagedPlants: 1,
        delivered: 1,
        inTransit: 1,
        loaded: 1,
        pending: 1,
        cancelled: 1,
        completedTrips: 1,
        activeDrivers: {
          $size: {
            $filter: {
              input: "$drivers",
              as: "d",
              cond: { $and: [{ $ne: ["$$d", null] }, { $ne: ["$$d", ""] }] },
            },
          },
        },
        activeVehicles: {
          $size: {
            $filter: {
              input: "$vehicles",
              as: "v",
              cond: { $and: [{ $ne: ["$$v", null] }, { $ne: ["$$v", ""] }] },
            },
          },
        },
      },
    },
  ]);

  return (
    row || {
      trips: 0,
      plants: 0,
      orders: 0,
      crates: 0,
      returnedPlants: 0,
      damagedPlants: 0,
      delivered: 0,
      inTransit: 0,
      loaded: 0,
      pending: 0,
      cancelled: 0,
      completedTrips: 0,
      activeDrivers: 0,
      activeVehicles: 0,
    }
  );
}

export async function aggregateFleetPeriods(rangeStart, rangeEnd, granularity = "day") {
  const rows = await Dispatch.aggregate([
    { $match: dispatchDateMatch(rangeStart, rangeEnd) },
    { $addFields: { ...DISPATCH_PLANT_QTY_FIELD, ...DISPATCH_ORDER_COUNT_FIELD } },
    {
      $group: {
        _id: periodKeyExpr(granularity),
        trips: { $sum: 1 },
        plants: { $sum: "$_plantQty" },
        orders: { $sum: "$_orderCount" },
        delivered: {
          $sum: { $cond: [{ $eq: ["$transportStatus", "DELIVERED"] }, 1, 0] },
        },
        inTransit: {
          $sum: { $cond: [{ $eq: ["$transportStatus", "IN_TRANSIT"] }, 1, 0] },
        },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        key: "$_id",
        trips: 1,
        plants: 1,
        orders: 1,
        delivered: 1,
        inTransit: 1,
        _id: 0,
      },
    },
  ]);
  return rows;
}

export async function aggregateTopDrivers(rangeStart, rangeEnd, limit = 12) {
  const rows = await Dispatch.aggregate([
    { $match: dispatchDateMatch(rangeStart, rangeEnd) },
    { $addFields: { ...DISPATCH_PLANT_QTY_FIELD, ...DISPATCH_ORDER_COUNT_FIELD } },
    {
      $group: {
        _id: {
          driverId: { $ifNull: ["$driverId", ""] },
          driverName: { $ifNull: ["$driverName", "Unknown"] },
          driverMobile: { $ifNull: ["$driverMobile", ""] },
        },
        trips: { $sum: 1 },
        plants: { $sum: "$_plantQty" },
        orders: { $sum: "$_orderCount" },
        delivered: {
          $sum: { $cond: [{ $eq: ["$transportStatus", "DELIVERED"] }, 1, 0] },
        },
        returnedPlants: { $sum: { $ifNull: ["$returnedPlants", 0] } },
      },
    },
    { $sort: { plants: -1 } },
    { $limit: limit },
    {
      $project: {
        driverId: { $toString: "$_id.driverId" },
        driverName: "$_id.driverName",
        driverMobile: "$_id.driverMobile",
        trips: 1,
        plants: 1,
        orders: 1,
        delivered: 1,
        returnedPlants: 1,
        deliveryRate: {
          $cond: [
            { $gt: ["$trips", 0] },
            { $round: [{ $multiply: [{ $divide: ["$delivered", "$trips"] }, 100] }, 1] },
            0,
          ],
        },
        _id: 0,
      },
    },
  ]);
  return rows;
}

export async function aggregateTopVehicles(rangeStart, rangeEnd, limit = 12) {
  const rows = await Dispatch.aggregate([
    { $match: dispatchDateMatch(rangeStart, rangeEnd) },
    {
      $addFields: {
        ...DISPATCH_PLANT_QTY_FIELD,
        ...DISPATCH_ORDER_COUNT_FIELD,
        ...DISPATCH_CRATE_COUNT_FIELD,
      },
    },
    {
      $group: {
        _id: {
          vehicleId: { $ifNull: ["$vehicleId", ""] },
          vehicleName: { $ifNull: ["$vehicleName", "Unknown"] },
          vehicleNumber: { $ifNull: ["$vehicleNumber", ""] },
        },
        trips: { $sum: 1 },
        plants: { $sum: "$_plantQty" },
        orders: { $sum: "$_orderCount" },
        crates: { $sum: "$_crateCount" },
        delivered: {
          $sum: { $cond: [{ $eq: ["$transportStatus", "DELIVERED"] }, 1, 0] },
        },
        inTransit: {
          $sum: { $cond: [{ $eq: ["$transportStatus", "IN_TRANSIT"] }, 1, 0] },
        },
        returnedPlants: { $sum: { $ifNull: ["$returnedPlants", 0] } },
        drivers: { $addToSet: "$driverName" },
      },
    },
    { $sort: { plants: -1 } },
    { $limit: limit },
    {
      $project: {
        vehicleId: { $toString: "$_id.vehicleId" },
        vehicleName: "$_id.vehicleName",
        vehicleNumber: "$_id.vehicleNumber",
        trips: 1,
        plants: 1,
        orders: 1,
        crates: 1,
        delivered: 1,
        inTransit: 1,
        returnedPlants: 1,
        driverCount: {
          $size: {
            $filter: {
              input: "$drivers",
              as: "d",
              cond: { $and: [{ $ne: ["$$d", null] }, { $ne: ["$$d", ""] }] },
            },
          },
        },
        deliveryRate: {
          $cond: [
            { $gt: ["$trips", 0] },
            { $round: [{ $multiply: [{ $divide: ["$delivered", "$trips"] }, 100] }, 1] },
            0,
          ],
        },
        _id: 0,
      },
    },
  ]);
  return rows;
}

async function villageDeliveryRows(rangeStart, rangeEnd) {
  return Dispatch.aggregate([
    { $match: dispatchDateMatch(rangeStart, rangeEnd) },
    { $addFields: DISPATCH_PLANT_QTY_FIELD },
    { $unwind: { path: "$orderDispatchDetails", preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        _orderOid: {
          $cond: [
            { $ifNull: ["$orderDispatchDetails.orderId", false] },
            "$orderDispatchDetails.orderId",
            { $arrayElemAt: ["$orderIds", 0] },
          ],
        },
        _linePlants: {
          $cond: [
            { $gt: [{ $ifNull: ["$orderDispatchDetails.dispatchQuantity", 0] }, 0] },
            "$orderDispatchDetails.dispatchQuantity",
            {
              $divide: [
                "$_plantQty",
                { $max: [{ $size: { $ifNull: ["$orderIds", []] } }, 1] },
              ],
            },
          ],
        },
      },
    },
    {
      $lookup: {
        from: "orders",
        localField: "_orderOid",
        foreignField: "_id",
        pipeline: [
          {
            $lookup: {
              from: "farmers",
              localField: "farmer",
              foreignField: "_id",
              pipeline: [{ $project: { village: 1, talukaName: 1 } }],
              as: "_farmer",
            },
          },
          {
            $project: {
              village: { $ifNull: [{ $arrayElemAt: ["$_farmer.village", 0] }, ""] },
              taluka: { $ifNull: [{ $arrayElemAt: ["$_farmer.talukaName", 0] }, ""] },
            },
          },
        ],
        as: "_order",
      },
    },
    {
      $addFields: {
        village: {
          $ifNull: [{ $arrayElemAt: ["$_order.village", 0] }, "Unknown"],
        },
        taluka: {
          $ifNull: [{ $arrayElemAt: ["$_order.taluka", 0] }, ""],
        },
      },
    },
    {
      $group: {
        _id: { village: "$village", taluka: "$taluka" },
        plants: { $sum: "$_linePlants" },
        orders: { $addToSet: "$_orderOid" },
        trips: { $addToSet: "$_id" },
      },
    },
    {
      $project: {
        village: "$_id.village",
        taluka: "$_id.taluka",
        plants: 1,
        orders: { $size: "$orders" },
        trips: { $size: "$trips" },
        _id: 0,
      },
    },
    { $sort: { plants: -1 } },
  ]);
}

export async function fetchVillageDeliveryBundle(rangeStart, rangeEnd, limit = 15) {
  const rows = await villageDeliveryRows(rangeStart, rangeEnd);
  return { topVillages: rows.slice(0, limit), villagesServed: rows.length };
}

export async function aggregateStatusMix(rangeStart, rangeEnd) {
  const rows = await Dispatch.aggregate([
    { $match: dispatchDateMatch(rangeStart, rangeEnd) },
    { $addFields: DISPATCH_PLANT_QTY_FIELD },
    {
      $group: {
        _id: "$transportStatus",
        trips: { $sum: 1 },
        plants: { $sum: "$_plantQty" },
      },
    },
    { $sort: { trips: -1 } },
    {
      $project: {
        status: "$_id",
        trips: 1,
        plants: 1,
        _id: 0,
      },
    },
  ]);
  return rows;
}

export async function fetchRecentTrips(rangeStart, rangeEnd, limit = 50) {
  const docs = await Dispatch.find(dispatchDateMatch(rangeStart, rangeEnd))
    .sort({ createdAt: -1 })
    .limit(limit)
    .select(
      "transportId transportStatus driverName driverMobile vehicleName vehicleNumber orderIds orderDispatchDetails plantsDetails returnedPlants damagedPlants tripId createdAt updatedAt"
    )
    .lean();

  return docs.map((d) => {
    let plants = 0;
    for (const od of d.orderDispatchDetails || []) {
      plants += Number(od.dispatchQuantity || 0);
    }
    if (!plants) {
      for (const pd of d.plantsDetails || []) {
        plants += Number(pd.quantity ?? pd.totalPlants ?? 0);
      }
    }
    return {
      id: String(d._id),
      transportId: d.transportId,
      status: d.transportStatus,
      driverName: d.driverName || "—",
      driverMobile: d.driverMobile || "",
      vehicleName: d.vehicleName || "—",
      vehicleNumber: d.vehicleNumber || "",
      plants,
      orders: (d.orderIds || []).length,
      returnedPlants: d.returnedPlants || 0,
      damagedPlants: d.damagedPlants || 0,
      hasTrip: Boolean(d.tripId),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  });
}
