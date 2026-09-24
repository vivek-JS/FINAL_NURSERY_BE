import mongoose from "mongoose";
import moment from "moment";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import { applySowingGapBoardMetrics } from "../utility/sowingGapSummaryMetrics.js";
import {
  getNativeDeliveryCohortOrders,
  groupOrdersByDeliverySlot,
} from "../utility/slotDispatchStats.js";
import {
  IST_OFFSET,
  slotDayEndMoment,
  slotDayStartMoment,
  slotWindowToDeliveryUtcRange,
} from "../utility/istSlotDate.js";
import {
  canBookFromExcess,
  capacityStatus,
  capacityYearsForRange,
  defaultCapacityRange,
  majoritySeedPlan,
  parseRangeBound,
  seedSourceTotals,
  slotDaySortKey,
  slotOverlapsRange,
} from "../utility/capacitySheetMetrics.js";

const ORDER_SELECT =
  "_id orderId orderStatus numberOfPlants additionalPlants sowingDone deliveryDate quotaSource pastDueSlotRollover pastDueSlotRolloverAt plantName plantSubtype sowingPlan farmer";

const DELIVERY_ORDER_FILTER = {
  deliveryDate: { $exists: true, $ne: null },
  orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
  $or: [
    { quotaSource: { $ne: "dealer" } },
    { quotaSource: { $exists: false } },
    { quotaSource: null },
  ],
};

function mongoSlotDayKey(dateExpr) {
  return {
    $let: {
      vars: { parts: { $split: [{ $ifNull: [dateExpr, ""] }, "-"] } },
      in: {
        $cond: [
          { $eq: [{ $size: "$$parts" }, 3] },
          {
            $convert: {
              input: {
                $concat: [
                  { $arrayElemAt: ["$$parts", 2] },
                  { $arrayElemAt: ["$$parts", 1] },
                  { $arrayElemAt: ["$$parts", 0] },
                ],
              },
              to: "int",
              onError: null,
              onNull: null,
            },
          },
          null,
        ],
      },
    },
  };
}

function deliveryBoundsForSlots(slots) {
  let minStart = null;
  let maxEnd = null;
  for (const slot of slots) {
    const start = slotDayStartMoment(slot.slotStartDay);
    const end = slotDayEndMoment(slot.slotEndDay);
    if (start && (!minStart || start.isBefore(minStart))) minStart = start;
    if (end && (!maxEnd || end.isAfter(maxEnd))) maxEnd = end;
  }
  if (!minStart || !maxEnd) return null;
  return {
    start: minStart.clone().utc().toDate(),
    end: maxEnd.clone().utc().toDate(),
  };
}

function num(n) {
  return Number(n) || 0;
}

function seedLabel(code) {
  if (code === "RAISING") return "Raising";
  if (code === "MIXED") return "Mixed";
  return "Company";
}

function rowFromMetrics(slot, metrics, orders) {
  const booked = num(metrics.totalBookedPlants);
  const covered = num(metrics.bookedCoveredPlants);
  const primarySowed = num(metrics.primarySowed) || num(slot.primarySowed);
  const sowed = covered > 0 ? covered : primarySowed;
  const gap = num(metrics.bookedUncoveredPlants);
  const excess = num(metrics.excessAvailableForBooking);
  const bookable = canBookFromExcess(excess, gap);
  const status = capacityStatus({ gap, excess });
  return {
    slotId: String(slot.slotId),
    startDay: slot.slotStartDay,
    endDay: slot.slotEndDay,
    booked,
    sowed,
    primarySowed,
    gap,
    excess,
    canBook: bookable,
    status,
    seedPlan: majoritySeedPlan(orders),
  };
}

function sumRows(rows) {
  return rows.reduce(
    (acc, row) => ({
      booked: acc.booked + row.booked,
      sowed: acc.sowed + row.sowed,
      primarySowed: acc.primarySowed + (Number(row.primarySowed) || 0),
      gap: acc.gap + row.gap,
      excess: acc.excess + row.excess,
      canBook: acc.canBook + row.canBook,
    }),
    { booked: 0, sowed: 0, primarySowed: 0, gap: 0, excess: 0, canBook: 0 }
  );
}

async function loadSheetContext({ from, to, plantId, subtypeId, unbounded = false }) {
  const plantQuery = { sowingAllowed: true };
  if (plantId && mongoose.Types.ObjectId.isValid(plantId)) {
    plantQuery._id = new mongoose.Types.ObjectId(plantId);
  }
  const plants = await PlantCms.find(plantQuery).select("_id name subtypes").lean();
  if (!plants.length) return { plants: [], slots: [], orders: [] };

  const plantIds = plants.map((p) => p._id);
  const fromKey = unbounded ? null : Number(from.format("YYYYMMDD"));
  const toKey = unbounded ? null : Number(to.format("YYYYMMDD"));
  const startKey = mongoSlotDayKey("$$slot.startDay");
  const endKey = mongoSlotDayKey("$$slot.endDay");
  const slotMatch = {
    plantId: { $in: plantIds },
    ...(unbounded ? {} : { year: { $in: capacityYearsForRange(from, to) } }),
  };

  const slots = await PlantSlot.aggregate([
    { $match: slotMatch },
    {
      $project: {
        plantId: 1,
        subtypeSlots: {
          $map: {
            input: "$subtypeSlots",
            as: "st",
            in: {
              subtypeId: "$$st.subtypeId",
              slots: {
                $map: {
                  input: {
                    $filter: {
                      input: { $ifNull: ["$$st.slots", []] },
                      as: "slot",
                      cond: {
                        $let: {
                          vars: { startKey, endKey },
                          in: {
                            $and: [
                              { $ne: ["$$startKey", null] },
                              { $ne: ["$$endKey", null] },
                              ...(unbounded
                                ? []
                                : [
                                    { $gte: ["$$endKey", fromKey] },
                                    { $lte: ["$$startKey", toKey] },
                                  ]),
                              ...(subtypeId && mongoose.Types.ObjectId.isValid(subtypeId)
                                ? [
                                    {
                                      $eq: [
                                        "$$st.subtypeId",
                                        new mongoose.Types.ObjectId(subtypeId),
                                      ],
                                    },
                                  ]
                                : []),
                            ],
                          },
                        },
                      },
                    },
                  },
                  as: "slot",
                  in: {
                    slotId: "$$slot._id",
                    slotStartDay: "$$slot.startDay",
                    slotEndDay: "$$slot.endDay",
                    primarySowed: { $ifNull: ["$$slot.primarySowed", 0] },
                    orderCoveredPlants: {
                      $sum: {
                        $map: {
                          input: { $ifNull: ["$$slot.sowingBatches", []] },
                          as: "batch",
                          in: {
                            $max: [0, { $ifNull: ["$$batch.orderCoveredPlants", 0] }],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    {
      $project: {
        plantId: 1,
        subtypeId: "$subtypeSlots.subtypeId",
        slotId: "$subtypeSlots.slots.slotId",
        slotStartDay: "$subtypeSlots.slots.slotStartDay",
        slotEndDay: "$subtypeSlots.slots.slotEndDay",
        primarySowed: "$subtypeSlots.slots.primarySowed",
        sowingBatches: [
          { orderCoveredPlants: "$subtypeSlots.slots.orderCoveredPlants" },
        ],
      },
    },
  ]);

  const bounds = deliveryBoundsForSlots(slots);
  if (!bounds) return { plants, slots, orders: [] };

  const orders = await Order.find({
    plantName: { $in: plantIds },
    ...(subtypeId && mongoose.Types.ObjectId.isValid(subtypeId)
      ? { plantSubtype: new mongoose.Types.ObjectId(subtypeId) }
      : {}),
    ...DELIVERY_ORDER_FILTER,
    deliveryDate: { $gte: bounds.start, $lte: bounds.end },
  })
    .select(ORDER_SELECT)
    .lean();

  return { plants, slots, orders };
}

function buildSheet({ plants, slots, orders, from, to, plantId, subtypeId, unbounded = false }) {
  const inRange = slots.filter((slot) => {
    if (plantId && String(slot.plantId) !== String(plantId)) return false;
    if (subtypeId && String(slot.subtypeId) !== String(subtypeId)) return false;
    if (unbounded) return true;
    return slotOverlapsRange(slot.slotStartDay, slot.slotEndDay, from, to);
  });

  const metricsBySlot = applySowingGapBoardMetrics(inRange, orders);
  const ordersBySubtype = new Map();
  for (const order of orders) {
    const key = `${String(order.plantName)}-${String(order.plantSubtype)}`;
    if (!ordersBySubtype.has(key)) ordersBySubtype.set(key, []);
    ordersBySubtype.get(key).push(order);
  }
  const slotsBySubtype = new Map();
  for (const slot of inRange) {
    const key = `${String(slot.plantId)}-${String(slot.subtypeId)}`;
    if (!slotsBySubtype.has(key)) slotsBySubtype.set(key, []);
    slotsBySubtype.get(key).push(slot);
  }
  const cohortBySlot = new Map();
  const seedOrders = [];
  for (const [key, subtypeSlots] of slotsBySubtype) {
    const grouped = groupOrdersByDeliverySlot(
      ordersBySubtype.get(key) || [],
      subtypeSlots.map((slot) => ({
        _id: slot.slotId,
        startDay: slot.slotStartDay,
        endDay: slot.slotEndDay,
      }))
    );
    for (const [id, list] of grouped) {
      cohortBySlot.set(id, getNativeDeliveryCohortOrders(list));
    }
  }

  const byPlant = new Map();
  for (const plant of plants) {
    if (plantId && String(plant._id) !== String(plantId)) continue;
    byPlant.set(String(plant._id), {
      plantId: String(plant._id),
      plantName: plant.name,
      subtypes: new Map(
        (plant.subtypes || [])
          .filter((st) => !subtypeId || String(st._id) === String(subtypeId))
          .map((st) => [
            String(st._id),
            {
              subtypeId: String(st._id),
              subtypeName: st.name,
              slots: [],
              orders: [],
            },
          ])
      ),
    });
  }

  for (const slot of inRange) {
    const plant = byPlant.get(String(slot.plantId));
    if (!plant) continue;
    const subtype = plant.subtypes.get(String(slot.subtypeId));
    if (!subtype) continue;
    const slotId = String(slot.slotId);
    const cohort = cohortBySlot.get(slotId) || [];
    subtype.orders.push(...cohort);
    seedOrders.push(...cohort);
    subtype.slots.push(rowFromMetrics(slot, metricsBySlot.get(slotId) || {}, cohort));
  }

  const plantRows = [];
  for (const plant of byPlant.values()) {
    const subtypes = [];
    for (const subtype of plant.subtypes.values()) {
      if (!subtype.slots.length) continue;
      subtype.slots.sort(
        (a, b) => (slotDaySortKey(a.startDay) || 0) - (slotDaySortKey(b.startDay) || 0)
      );
      const totals = sumRows(subtype.slots);
      subtypes.push({
        subtypeId: subtype.subtypeId,
        subtypeName: subtype.subtypeName,
        seedPlan: majoritySeedPlan(subtype.orders),
        seedPlanLabel: seedLabel(majoritySeedPlan(subtype.orders)),
        deliveryFrom: subtype.slots[0].startDay,
        deliveryTo: subtype.slots[subtype.slots.length - 1].endDay,
        ...totals,
        status: capacityStatus(totals),
        slots: subtype.slots.map((slot) => ({
          ...slot,
          seedPlanLabel: seedLabel(slot.seedPlan),
        })),
      });
    }
    if (!subtypes.length) continue;
    subtypes.sort((a, b) => a.subtypeName.localeCompare(b.subtypeName));
    const totals = sumRows(subtypes);
    plantRows.push({
      plantId: plant.plantId,
      plantName: plant.plantName,
      ...totals,
      status: capacityStatus(totals),
      subtypes,
    });
  }
  plantRows.sort((a, b) => a.plantName.localeCompare(b.plantName));
  return { plants: plantRows, seedSources: seedSourceTotals(seedOrders) };
}

export async function loadCapacitySheetPayload({ from, to, plantId = null, subtypeId = null, unbounded = false }) {
  const ctx = await loadSheetContext({ from, to, plantId, subtypeId, unbounded });
  const sheet = buildSheet({
    ...ctx,
    from,
    to,
    plantId,
    subtypeId,
    unbounded,
  });
  const totals = sumRows(sheet.plants);
  return {
    from: unbounded ? null : from.format("YYYY-MM-DD"),
    to: unbounded ? null : to.format("YYYY-MM-DD"),
    totals: { ...totals, status: capacityStatus(totals) },
    seedSources: sheet.seedSources,
    plants: sheet.plants,
  };
}

export const getCapacitySheet = async (req, res) => {
  try {
    const unbounded = String(req.query.all || "") === "1";
    const defaults = defaultCapacityRange();
    const from = unbounded ? defaults.from : parseRangeBound(req.query.from, defaults.from);
    const to = unbounded ? defaults.to : parseRangeBound(req.query.to, defaults.to);
    if (!unbounded && to.isBefore(from, "day")) {
      return res.status(400).json({
        success: false,
        message: "to must be on or after from",
      });
    }

    const plantId = req.query.plantId || null;
    const subtypeId = req.query.subtypeId || null;
    const payload = await loadCapacitySheetPayload({ from, to, plantId, subtypeId, unbounded });

    return res.status(200).json({
      success: true,
      ...payload,
    });
  } catch (error) {
    console.error("getCapacitySheet:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load capacity sheet",
    });
  }
};

export const getCapacitySlotDetail = async (req, res) => {
  try {
    const { slotId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(slotId)) {
      return res.status(400).json({ success: false, message: "Valid slot id is required" });
    }
    const sid = new mongoose.Types.ObjectId(slotId);
    const doc = await PlantSlot.findOne({ "subtypeSlots.slots._id": sid })
      .select("plantId subtypeSlots.subtypeId subtypeSlots.slots")
      .lean();
    let slot = null;
    for (const subtypeSlot of doc?.subtypeSlots || []) {
      const found = (subtypeSlot.slots || []).find((row) => String(row._id) === String(sid));
      if (!found) continue;
      slot = {
        plantId: doc.plantId,
        subtypeId: subtypeSlot.subtypeId,
        slotId: found._id,
        slotStartDay: found.startDay,
        slotEndDay: found.endDay,
        primarySowed: num(found.primarySowed),
        orderReservedPlants: num(found.orderReservedPlants),
        actualPlants: num(found.actualPlants),
        expectedMortality: num(found.expectedMortality),
        actualReadyPlants: num(found.actualReadyPlants),
        lagwadRemaining: num(found.lagwadRemaining),
        sowingBatches: found.sowingBatches || [],
      };
      break;
    }
    if (!slot) {
      return res.status(404).json({ success: false, message: "Slot not found" });
    }

    const plant = await PlantCms.findById(slot.plantId).select("name subtypes").lean();
    const subtype = (plant?.subtypes || []).find(
      (st) => String(st._id) === String(slot.subtypeId)
    );

    const windowRange = slotWindowToDeliveryUtcRange({
      startDay: slot.slotStartDay,
      endDay: slot.slotEndDay,
    });
    const deliveryOrders = await Order.find({
      plantName: slot.plantId,
      plantSubtype: slot.subtypeId,
      ...DELIVERY_ORDER_FILTER,
      ...(windowRange
        ? { deliveryDate: { $gte: windowRange.start, $lte: windowRange.end } }
        : {}),
    })
      .select(ORDER_SELECT)
      .lean();

    const metricsBySlot = applySowingGapBoardMetrics([slot], deliveryOrders);
    const metrics = metricsBySlot.get(String(slot.slotId)) || {};
    const cohort = getNativeDeliveryCohortOrders(
      groupOrdersByDeliverySlot(deliveryOrders, [
        { _id: slot.slotId, startDay: slot.slotStartDay, endDay: slot.slotEndDay },
      ]).get(String(slot.slotId)) || []
    );
    const numbers = rowFromMetrics(slot, metrics, cohort);

    const bookedOrders = await Order.find({
      bookingSlot: sid,
      orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
      $or: [
        { quotaSource: { $ne: "dealer" } },
        { quotaSource: { $exists: false } },
        { quotaSource: null },
      ],
    })
      .select(
        "orderId numberOfPlants additionalPlants deliveryDate orderBookingDate createdAt sowingDone sowingPlan orderStatus farmer"
      )
      .populate("farmer", "name mobileNumber")
      .sort({ deliveryDate: 1, orderId: 1 })
      .lean();

    const orders = bookedOrders.map((order) => ({
      orderId: String(order._id),
      orderNumber: order.orderId,
      farmerName: order.farmer?.name || "",
      farmerMobile: order.farmer?.mobileNumber || "",
      plants: num(order.numberOfPlants) + num(order.additionalPlants),
      bookingDate: order.orderBookingDate || order.createdAt || null,
      deliveryDate: order.deliveryDate || null,
      sowingDone: Boolean(order.sowingDone),
      seedPlan: String(order.sowingPlan?.seedSource || "COMPANY").toUpperCase(),
      orderStatus: order.orderStatus,
    }));

    const batches = (slot.sowingBatches || []).map((batch) => ({
      requestNumber: batch.requestNumber || "",
      sowingDate: batch.sowingDate || "",
      plantReadyDate: batch.plantReadyDate || "",
      plantReadyDays: num(batch.plantReadyDays),
      plantsSowed: num(batch.plantsSowed),
      packetsUsed: num(batch.packetsUsed),
      orderCoveredPlants: num(batch.orderCoveredPlants),
      excessPlants: num(batch.excessPlants),
      actualPlantsApplied: num(batch.actualPlantsApplied),
      expectedMortalityApplied: num(batch.expectedMortalityApplied),
      availablePlantsApplied: num(batch.availablePlantsApplied),
      shedName: batch.shedName || "",
      isExcessiveSowing: Boolean(batch.isExcessiveSowing),
    }));
    const lagwadEntries = batches.filter(
      (batch) => batch.excessPlants > 0 || batch.isExcessiveSowing || batch.availablePlantsApplied > 0
    );

    return res.status(200).json({
      success: true,
      slot: {
        ...numbers,
        seedPlanLabel: seedLabel(numbers.seedPlan),
        plantId: String(slot.plantId),
        plantName: plant?.name || "",
        subtypeId: String(slot.subtypeId),
        subtypeName: subtype?.name || "",
        orderReservedPlants: num(slot.orderReservedPlants),
        primarySowed: num(slot.primarySowed),
        lagwad: {
          actualPlants: num(slot.actualPlants),
          expectedMortality: num(slot.expectedMortality),
          actualReadyPlants: num(slot.actualReadyPlants),
          lagwadRemaining: num(slot.lagwadRemaining),
        },
      },
      orders,
      batches,
      lagwadEntries,
      generatedAt: moment().utcOffset(IST_OFFSET).toISOString(),
    });
  } catch (error) {
    console.error("getCapacitySlotDetail:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load slot capacity",
    });
  }
};
