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
import { IST_OFFSET } from "../utility/istSlotDate.js";
import {
  canBookPlants,
  capacityStatus,
  defaultCapacityRange,
  majoritySeedPlan,
  parseRangeBound,
  slotOverlapsRange,
} from "../utility/capacitySheetMetrics.js";

const ORDER_SELECT =
  "_id orderId orderStatus numberOfPlants additionalPlants sowingDone deliveryDate quotaSource pastDueSlotRollover pastDueSlotRolloverAt plantName plantSubtype sowingPlan farmer";

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
  const sowed = num(metrics.bookedCoveredPlants);
  const gap = num(metrics.bookedUncoveredPlants);
  const excess = num(metrics.excessAvailableForBooking);
  const bookable = canBookPlants(slot.totalPlants, booked, slot.bufferAmount);
  const status = capacityStatus({ gap, excess });
  return {
    slotId: String(slot.slotId),
    startDay: slot.slotStartDay,
    endDay: slot.slotEndDay,
    booked,
    sowed,
    gap,
    excess,
    canBook: bookable,
    status,
    seedPlan: majoritySeedPlan(orders),
    totalPlants: num(slot.totalPlants),
    bufferAmount: num(slot.bufferAmount),
  };
}

function sumRows(rows) {
  return rows.reduce(
    (acc, row) => ({
      booked: acc.booked + row.booked,
      sowed: acc.sowed + row.sowed,
      gap: acc.gap + row.gap,
      excess: acc.excess + row.excess,
      canBook: acc.canBook + row.canBook,
    }),
    { booked: 0, sowed: 0, gap: 0, excess: 0, canBook: 0 }
  );
}

async function loadSheetContext() {
  const plants = await PlantCms.find({ sowingAllowed: true })
    .select("_id name subtypes")
    .lean();
  if (!plants.length) return { plants: [], slots: [], orders: [] };

  const plantIds = plants.map((p) => p._id);
  const slots = await PlantSlot.aggregate([
    { $match: { plantId: { $in: plantIds } } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    {
      $project: {
        plantId: 1,
        subtypeId: "$subtypeSlots.subtypeId",
        slotId: "$subtypeSlots.slots._id",
        slotStartDay: "$subtypeSlots.slots.startDay",
        slotEndDay: "$subtypeSlots.slots.endDay",
        totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
        bufferAmount: { $ifNull: ["$subtypeSlots.slots.bufferAmount", 0] },
        primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
        availablePlants: { $ifNull: ["$subtypeSlots.slots.availablePlants", 0] },
        sowingBatches: { $ifNull: ["$subtypeSlots.slots.sowingBatches", []] },
      },
    },
  ]);

  const orders = await Order.find({
    plantName: { $in: plantIds },
    deliveryDate: { $exists: true, $ne: null },
    orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
    $or: [
      { quotaSource: { $ne: "dealer" } },
      { quotaSource: { $exists: false } },
      { quotaSource: null },
    ],
  })
    .select(ORDER_SELECT)
    .lean();

  return { plants, slots, orders };
}

function buildSheet({ plants, slots, orders, from, to, plantId, subtypeId }) {
  const inRange = slots.filter((slot) => {
    if (plantId && String(slot.plantId) !== String(plantId)) return false;
    if (subtypeId && String(slot.subtypeId) !== String(subtypeId)) return false;
    return slotOverlapsRange(slot.slotStartDay, slot.slotEndDay, from, to);
  });

  const metricsBySlot = applySowingGapBoardMetrics(inRange, orders);
  const slotRows = inRange.map((slot) => ({
    _id: slot.slotId,
    startDay: slot.slotStartDay,
    endDay: slot.slotEndDay,
  }));
  const ordersBySlot = groupOrdersByDeliverySlot(orders, slotRows);

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
    const cohort = getNativeDeliveryCohortOrders(ordersBySlot.get(slotId) || []);
    subtype.orders.push(...cohort);
    subtype.slots.push(rowFromMetrics(slot, metricsBySlot.get(slotId) || {}, cohort));
  }

  const plantRows = [];
  for (const plant of byPlant.values()) {
    const subtypes = [];
    for (const subtype of plant.subtypes.values()) {
      if (!subtype.slots.length) continue;
      subtype.slots.sort(
        (a, b) =>
          (slotDaySort(a.startDay) || 0) - (slotDaySort(b.startDay) || 0)
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
  return plantRows;
}

function slotDaySort(ddmmyyyy) {
  const m = moment(ddmmyyyy, "DD-MM-YYYY", true);
  return m.isValid() ? m.valueOf() : 0;
}

export const getCapacitySheet = async (req, res) => {
  try {
    const defaults = defaultCapacityRange();
    const from = parseRangeBound(req.query.from, defaults.from);
    const to = parseRangeBound(req.query.to, defaults.to);
    if (to.isBefore(from, "day")) {
      return res.status(400).json({
        success: false,
        message: "to must be on or after from",
      });
    }

    const ctx = await loadSheetContext();
    const plants = buildSheet({
      ...ctx,
      from,
      to,
      plantId: req.query.plantId || null,
      subtypeId: req.query.subtypeId || null,
    });
    const totals = sumRows(plants);

    return res.status(200).json({
      success: true,
      from: from.format("YYYY-MM-DD"),
      to: to.format("YYYY-MM-DD"),
      totals: { ...totals, status: capacityStatus(totals) },
      plants,
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
    const rows = await PlantSlot.aggregate([
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      { $match: { "subtypeSlots.slots._id": sid } },
      {
        $project: {
          plantId: 1,
          subtypeId: "$subtypeSlots.subtypeId",
          slotId: "$subtypeSlots.slots._id",
          slotStartDay: "$subtypeSlots.slots.startDay",
          slotEndDay: "$subtypeSlots.slots.endDay",
          totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
          bufferAmount: { $ifNull: ["$subtypeSlots.slots.bufferAmount", 0] },
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          availablePlants: { $ifNull: ["$subtypeSlots.slots.availablePlants", 0] },
          orderReservedPlants: { $ifNull: ["$subtypeSlots.slots.orderReservedPlants", 0] },
          sowingBatches: { $ifNull: ["$subtypeSlots.slots.sowingBatches", []] },
        },
      },
    ]);
    const slot = rows[0];
    if (!slot) {
      return res.status(404).json({ success: false, message: "Slot not found" });
    }

    const plant = await PlantCms.findById(slot.plantId).select("name subtypes").lean();
    const subtype = (plant?.subtypes || []).find(
      (st) => String(st._id) === String(slot.subtypeId)
    );

    const deliveryOrders = await Order.find({
      plantName: slot.plantId,
      plantSubtype: slot.subtypeId,
      deliveryDate: { $exists: true, $ne: null },
      orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
      $or: [
        { quotaSource: { $ne: "dealer" } },
        { quotaSource: { $exists: false } },
        { quotaSource: null },
      ],
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
        "orderId numberOfPlants additionalPlants deliveryDate sowingDone sowingPlan orderStatus farmer"
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
      deliveryDate: order.deliveryDate,
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
      isExcessiveSowing: Boolean(batch.isExcessiveSowing),
    }));

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
      },
      orders,
      batches,
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
