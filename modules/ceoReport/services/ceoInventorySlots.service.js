import Order from "../../../models/order.model.js";
import PlantCms from "../../../models/plantCms.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
} from "../../../utility/istOrderDateStats.js";
import { parseCeoReportQuery } from "../utility/ceoQueryParams.js";

export async function fetchCeoInventorySlots(query = {}) {
  const opts = parseCeoReportQuery(query);
  if (opts.error) return { error: opts.error, statusCode: 400 };

  const { rangeStart, rangeEnd, startYmd, endYmd, depth, extraMatch, year } = opts;

  const bookedByPlant = await Order.aggregate([
    {
      $match: {
        ...orderStatusExcludeMatch(),
        ...extraMatch,
        orderBookingDate: { $gte: rangeStart, $lte: rangeEnd },
        orderStatus: {
          $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED", "COMPLETED"],
        },
      },
    },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    {
      $group: {
        _id: "$plantName",
        bookedPlants: { $sum: "$linePlantTotal" },
        bookedOrders: { $sum: 1 },
      },
    },
  ]);

  const plants = await PlantCms.find(extraMatch.plantName ? { _id: extraMatch.plantName } : {})
    .select("name subtypes")
    .lean();

  const bookedMap = new Map(
    bookedByPlant.map((r) => [String(r._id), r])
  );

  let totalCapacity = 0;
  let totalBooked = 0;
  const plantRows = [];

  for (const plant of plants) {
    const booked = bookedMap.get(String(plant._id)) || { bookedPlants: 0, bookedOrders: 0 };
    const capacityEstimate = (plant.subtypes || []).reduce(
      (sum, st) => sum + (st.totalPlants || st.capacity || 0),
      0
    );
    const cap = capacityEstimate || booked.bookedPlants * 1.2;
    const available = Math.max(0, cap - booked.bookedPlants);
    const util = cap > 0 ? Math.round((booked.bookedPlants / cap) * 100) : 0;

    totalCapacity += cap;
    totalBooked += booked.bookedPlants;

    plantRows.push({
      plantId: plant._id,
      plantName: plant.name,
      totalCapacity: Math.round(cap),
      bookedPlants: booked.bookedPlants,
      bookedOrders: booked.bookedOrders,
      availablePlants: Math.round(available),
      utilizationPct: util,
      status: util >= 100 ? "overbooked" : util >= 85 ? "full" : util >= 50 ? "ok" : "low",
    });
  }

  plantRows.sort((a, b) => b.bookedPlants - a.bookedPlants);

  const utilizationPct =
    totalCapacity > 0 ? Math.round((totalBooked / totalCapacity) * 100) : 0;

  const payload = {
    tab: "inventory-slots",
    timezone: "Asia/Kolkata",
    depth,
    year,
    range: { startDate: startYmd, endDate: endYmd },
    summary: {
      totalCapacity: Math.round(totalCapacity),
      bookedPlants: totalBooked,
      availablePlants: Math.round(Math.max(0, totalCapacity - totalBooked)),
      utilizationPct,
      overbookedCount: plantRows.filter((p) => p.status === "overbooked").length,
      lowStockCount: plantRows.filter((p) => p.status === "low").length,
    },
  };

  if (depth !== "summary") {
    payload.plantRows = plantRows;
    payload.periods = plantRows.map((p) => ({
      key: String(p.plantId),
      label: p.plantName,
      totalCapacity: p.totalCapacity,
      bookedPlants: p.bookedPlants,
      availablePlants: p.availablePlants,
      utilizationPct: p.utilizationPct,
      status: p.status,
    }));
  }

  return { data: payload };
}
