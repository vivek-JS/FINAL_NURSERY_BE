import mongoose from "mongoose";
import moment from "moment";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import { IST_OFFSET, deliveryDateToIstMoment } from "../utility/istSlotDate.js";
import SowingEntry from "../models/sowingEntry.model.js";
import { attachExcess, attachSowingRemaining, buildSafeZone, orderCoverSowings, orderSafeCover, parseSafeZoneTill, readyOnDay, safeZoneDeliveryMatch, safeZoneOrders, sowingDayFigures, sowingEntryRemaining } from "../utility/safeZone.js";
import { allocateVirtualCover, coverYmd } from "../utility/virtualCover.js";
import { storedShownExcess } from "../utility/sowingBatchExcessStamp.js";

const ORDER_SELECT =
  "orderId numberOfPlants additionalPlants orderBookingDate createdAt deliveryDate oldDeliveryDate orderStatus quotaSource sowingDone sowingCoverSources sowingCoverReversedAt sowingPartialCover plantName plantSubtype farmer";

function oid(value) {
  return value && mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

async function sowingPlants(plantId) {
  const query = { sowingAllowed: true };
  const id = oid(plantId);
  if (plantId && !id) return [];
  if (id) query._id = id;
  return PlantCms.find(query).select("name subtypes._id subtypes.name").lean();
}

async function batchesById(ids) {
  const oids = [...new Set(ids.map((id) => String(id || "")).filter((id) => mongoose.Types.ObjectId.isValid(id)))].map(
    (id) => new mongoose.Types.ObjectId(id)
  );
  if (!oids.length) return new Map();
  const rows = await PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots.sowingBatches._id": { $in: oids } } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $unwind: "$subtypeSlots.slots.sowingBatches" },
    { $match: { "subtypeSlots.slots.sowingBatches._id": { $in: oids } } },
    {
      $project: {
        _id: "$subtypeSlots.slots.sowingBatches._id",
        plantsSowed: "$subtypeSlots.slots.sowingBatches.plantsSowed",
        destroyedPlants: "$subtypeSlots.slots.sowingBatches.destroyedPlants",
        sowingBufferPct: "$subtypeSlots.slots.sowingBatches.sowingBufferPct",
        bufferPlants: "$subtypeSlots.slots.sowingBatches.bufferPlants",
        mortalityMovedToExcess: "$subtypeSlots.slots.sowingBatches.mortalityMovedToExcess",
        excessMovedToMortality: "$subtypeSlots.slots.sowingBatches.excessMovedToMortality",
        isIrrelevant: "$subtypeSlots.slots.sowingBatches.isIrrelevant",
        noMortalityReserve: "$subtypeSlots.slots.sowingBatches.noMortalityReserve",
      },
    },
  ]);
  return new Map(rows.map((row) => [String(row._id), row]));
}

async function coverLines({ till, plantId, subtypeId }) {
  const range = parseSafeZoneTill(till);
  if (range.error) return { error: range.error, status: 400 };

  const plants = await sowingPlants(plantId);
  if (!plants.length) {
    return { range, lines: [], names: new Map(), plantIds: [] };
  }

  const subtypeFilter = oid(subtypeId);
  const names = new Map();
  const plantIds = [];
  for (const plant of plants) {
    plantIds.push(plant._id);
    for (const subtype of plant.subtypes || []) {
      names.set(`${plant._id}|${subtype._id}`, {
        plantId: String(plant._id),
        subtypeId: String(subtype._id),
        plantName: plant.name || "Plant",
        subtypeName: subtype.name || "",
      });
    }
  }

  const orders = await Order.find({
    plantName: { $in: plantIds },
    ...(subtypeFilter ? { plantSubtype: subtypeFilter } : {}),
    $and: [
      { $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }, { quotaSource: null }] },
      safeZoneDeliveryMatch(range),
    ],
  })
    .select(ORDER_SELECT)
    .populate("farmer", "name")
    .lean();

  const batchIds = [];
  for (const order of orders) {
    if (order.sowingCoverReversedAt) continue;
    for (const source of order.sowingCoverSources || []) {
      if (source?.batchId) batchIds.push(source.batchId);
    }
  }
  const batches = await batchesById(batchIds);

  const lines = [];
  for (const order of orders) {
    const meta =
      names.get(`${order.plantName}|${order.plantSubtype}`) || {
        plantId: String(order.plantName || ""),
        subtypeId: String(order.plantSubtype || ""),
        plantName: "Plant",
        subtypeName: "",
      };
    const cover = orderSafeCover(order, batches);
    if (cover.booked < 1) continue;
    const deliveryDate = deliveryDateToIstMoment(order.deliveryDate)?.format("YYYY-MM-DD") || "";
    const originalDeliveryDate = deliveryDateToIstMoment(order.oldDeliveryDate)?.format("YYYY-MM-DD") || "";
    const bookingDate = deliveryDateToIstMoment(order.orderBookingDate || order.createdAt)?.format("YYYY-MM-DD") || "";
    lines.push({
      ...meta,
      orderId: String(order._id),
      orderNumber: order.orderId ?? "",
      farmerName: order.farmer?.name || "",
      bookingDate,
      deliveryDate,
      originalDeliveryDate,
      dateChanged: Boolean(originalDeliveryDate && originalDeliveryDate !== deliveryDate),
      overdue: Boolean(originalDeliveryDate && originalDeliveryDate < range.till && deliveryDate > range.till),
      covers: orderCoverSowings(order, batches),
      ...cover,
    });
  }
  return { range, lines, names, plantIds };
}

async function excessByVariety(plantIds, subtypeId, tillYmd) {
  if (!plantIds?.length || !tillYmd) return new Map();
  const subtypeFilter = oid(subtypeId);
  const rows = await PlantSlot.aggregate([
    { $match: { plantId: { $in: plantIds }, "subtypeSlots.slots.sowingBatches.0": { $exists: true } } },
    { $unwind: "$subtypeSlots" },
    ...(subtypeFilter ? [{ $match: { "subtypeSlots.subtypeId": subtypeFilter } }] : []),
    { $unwind: "$subtypeSlots.slots" },
    { $unwind: "$subtypeSlots.slots.sowingBatches" },
    { $match: { "subtypeSlots.slots.sowingBatches.isIrrelevant": { $ne: true } } },
    {
      $project: {
        plantId: 1,
        subtypeId: "$subtypeSlots.subtypeId",
        plantReadyDate: "$subtypeSlots.slots.sowingBatches.plantReadyDate",
        plantsSowed: "$subtypeSlots.slots.sowingBatches.plantsSowed",
        destroyedPlants: "$subtypeSlots.slots.sowingBatches.destroyedPlants",
        orderCoveredPlants: "$subtypeSlots.slots.sowingBatches.orderCoveredPlants",
        sowingBufferPct: "$subtypeSlots.slots.sowingBatches.sowingBufferPct",
        bufferPlants: "$subtypeSlots.slots.sowingBatches.bufferPlants",
        mortalityMovedToExcess: "$subtypeSlots.slots.sowingBatches.mortalityMovedToExcess",
        excessMovedToMortality: "$subtypeSlots.slots.sowingBatches.excessMovedToMortality",
        isIrrelevant: "$subtypeSlots.slots.sowingBatches.isIrrelevant",
        noMortalityReserve: "$subtypeSlots.slots.sowingBatches.noMortalityReserve",
      },
    },
  ]);
  const totals = new Map();
  for (const row of rows) {
    if (!readyOnDay(row.plantReadyDate, tillYmd)) continue;
    const day = sowingDayFigures(row);
    const excess = storedShownExcess(row);
    if (day.sowing < 1 && day.mortality < 1 && excess < 1) continue;
    const key = `${row.plantId}|${row.subtypeId}`;
    const current = totals.get(key) || { excess: 0, sowing: 0, mortality: 0 };
    current.excess += excess;
    current.sowing += day.sowing;
    current.mortality += day.mortality;
    totals.set(key, current);
  }
  return totals;
}

const REMAINING_SELECT =
  "plantId subtypeId requestNumber sowDay sowingDate plantReadyDate shedName plantsSowed destroyedPlants dispatchedPlants bufferPlants sowingBufferPct mortalityMovedToExcess excessMovedToMortality noMortalityReserve isIrrelevant";

function todayYmd() {
  return moment().utcOffset(IST_OFFSET).format("YYYY-MM-DD");
}

async function remainingByVariety(plantIds, subtypeId) {
  if (!plantIds?.length) return new Map();
  const subtypeFilter = oid(subtypeId);
  const docs = await SowingEntry.find({
    plantId: { $in: plantIds },
    ...(subtypeFilter ? { subtypeId: subtypeFilter } : {}),
    isIrrelevant: { $ne: true },
  })
    .select(REMAINING_SELECT)
    .lean();
  const totals = new Map();
  for (const doc of docs) {
    const remaining = sowingEntryRemaining(doc);
    if (remaining < 1) continue;
    const key = `${doc.plantId}|${doc.subtypeId}`;
    totals.set(key, (totals.get(key) || 0) + remaining);
  }
  return totals;
}

async function remainingSowings(plantId, subtypeId) {
  const plant = oid(plantId);
  const subtype = oid(subtypeId);
  if (!plant || !subtype) return [];
  const docs = await SowingEntry.find({ plantId: plant, subtypeId: subtype, isIrrelevant: { $ne: true } })
    .select(REMAINING_SELECT)
    .lean();
  return docs
    .map((doc) => {
      const remaining = sowingEntryRemaining(doc);
      return {
        requestNumber: doc.requestNumber || "",
        sowingDate: doc.sowDay || doc.sowingDate || "",
        plantReadyDate: doc.plantReadyDate || "",
        shedName: doc.shedName || "",
        sowed: Math.max(0, Math.floor(Number(doc.plantsSowed) || 0)),
        out: Math.max(0, Math.floor(Number(doc.dispatchedPlants) || 0)),
        remaining,
      };
    })
    .filter((row) => row.remaining > 0)
    .sort((a, b) => String(a.sowingDate).localeCompare(String(b.sowingDate)) || String(a.requestNumber).localeCompare(String(b.requestNumber)));
}

/** GET /sowing/capacity-sheet/safe-zone?till=YYYY-MM-DD */
export const getSafeZone = async (req, res) => {
  try {
    const loaded = await coverLines({
      till: req.query.till || req.query.to,
      plantId: req.query.plantId,
      subtypeId: req.query.subtypeId,
    });
    if (loaded.error) {
      return res.status(loaded.status || 400).json({ success: false, message: loaded.error });
    }
    const [excess, remaining] = await Promise.all([
      excessByVariety(loaded.plantIds, req.query.subtypeId, loaded.range.till),
      remainingByVariety(loaded.plantIds, req.query.subtypeId),
    ]);
    const board = attachSowingRemaining(
      attachExcess(buildSafeZone(loaded.lines, todayYmd()), excess),
      remaining,
      loaded.names
    );
    return res.status(200).json({
      success: true,
      till: loaded.range.till,
      from: loaded.range.till,
      to: loaded.range.till,
      ...board,
      generatedAt: moment().utcOffset(IST_OFFSET).toISOString(),
    });
  } catch (error) {
    console.error("getSafeZone:", error);
    return res.status(500).json({ success: false, message: "Failed to load safe zone" });
  }
};

async function remainingSowingRows(plantIds, subtypeId) {
  if (!plantIds?.length) return new Map();
  const subtypeFilter = oid(subtypeId);
  const docs = await SowingEntry.find({
    plantId: { $in: plantIds },
    ...(subtypeFilter ? { subtypeId: subtypeFilter } : {}),
    isIrrelevant: { $ne: true },
  })
    .select(REMAINING_SELECT)
    .lean();
  const grouped = new Map();
  for (const doc of docs) {
    const remaining = sowingEntryRemaining(doc);
    if (remaining < 1) continue;
    const key = `${doc.plantId}|${doc.subtypeId}`;
    const rows = grouped.get(key) || [];
    rows.push({
      requestNumber: doc.requestNumber || "",
      sowingDate: coverYmd(doc.sowDay || doc.sowingDate),
      plantReadyDate: coverYmd(doc.plantReadyDate),
      shedName: doc.shedName || "",
      remaining,
    });
    grouped.set(key, rows);
  }
  return grouped;
}

/** GET /sowing/capacity-sheet/virtual-cover?to=YYYY-MM-DD */
export const getVirtualCover = async (req, res) => {
  try {
    const loaded = await coverLines({
      till: req.query.till || req.query.to,
      plantId: req.query.plantId,
      subtypeId: req.query.subtypeId,
    });
    if (loaded.error) {
      return res.status(loaded.status || 400).json({ success: false, message: loaded.error });
    }
    const sowings = await remainingSowingRows(loaded.plantIds, req.query.subtypeId);
    const byVariety = new Map();
    for (const line of loaded.lines) {
      const key = `${line.plantId}|${line.subtypeId}`;
      const bucket = byVariety.get(key) || {
        plantId: line.plantId,
        subtypeId: line.subtypeId,
        plantName: line.plantName,
        subtypeName: line.subtypeName,
        orders: [],
      };
      bucket.orders.push({
        orderId: line.orderId,
        orderNumber: line.orderNumber,
        farmerName: line.farmerName,
        deliveryDate: line.deliveryDate,
        bookingDate: line.bookingDate,
        plants: line.total,
      });
      byVariety.set(key, bucket);
    }
    for (const [key, rows] of sowings) {
      if (byVariety.has(key) || !rows.length) continue;
      const meta = loaded.names?.get?.(key) || {};
      const [plantId, subtypeId] = key.split("|");
      byVariety.set(key, {
        plantId,
        subtypeId,
        plantName: meta.plantName || "Plant",
        subtypeName: meta.subtypeName || "",
        orders: [],
      });
    }
    const varieties = [...byVariety.values()]
      .map((row) => {
        const key = `${row.plantId}|${row.subtypeId}`;
        const allocated = allocateVirtualCover(row.orders, sowings.get(key) || []);
        const plants = allocated.orders.reduce((sum, order) => sum + order.plants, 0);
        return {
          plantId: row.plantId,
          subtypeId: row.subtypeId,
          plantName: row.plantName,
          subtypeName: row.subtypeName,
          orders: allocated.orders.length,
          plants,
          left: allocated.left,
          balance: allocated.balance,
          deliveries: allocated.orders,
        };
      })
      .filter((row) => row.plants > 0)
      .sort((a, b) => b.plants - a.plants || a.plantName.localeCompare(b.plantName) || a.subtypeName.localeCompare(b.subtypeName));
    return res.status(200).json({
      success: true,
      till: loaded.range.till,
      today: todayYmd(),
      plants: varieties.reduce((sum, row) => sum + row.plants, 0),
      varieties,
      generatedAt: moment().utcOffset(IST_OFFSET).toISOString(),
    });
  } catch (error) {
    console.error("getVirtualCover:", error);
    return res.status(500).json({ success: false, message: "Failed to load virtual cover" });
  }
};

/** GET /sowing/capacity-sheet/safe-zone/orders — accepted orders for one variety, by delivery date. */
export const getSafeZoneOrders = async (req, res) => {
  try {
    const plantId = String(req.query.plantId || "");
    const subtypeId = String(req.query.subtypeId || "");
    if (!oid(plantId) || !oid(subtypeId)) {
      return res.status(400).json({ success: false, message: "Plant and subtype are required" });
    }
    const loaded = await coverLines({
      till: req.query.till || req.query.to,
      plantId,
      subtypeId,
    });
    if (loaded.error) {
      return res.status(loaded.status || 400).json({ success: false, message: loaded.error });
    }
    const today = todayYmd();
    const orders = safeZoneOrders(loaded.lines)
      .filter((line) => line.plantId === plantId && line.subtypeId === subtypeId)
      .map((line) => ({ ...line, pastDue: Boolean(line.deliveryDate && line.deliveryDate < today) }));
    const sowings = await remainingSowings(plantId, subtypeId);
    const sample = orders[0];
    const named = loaded.names?.get?.(`${plantId}|${subtypeId}`);
    return res.status(200).json({
      success: true,
      till: loaded.range.till,
      from: loaded.range.till,
      to: loaded.range.till,
      plantId,
      subtypeId,
      plantName: sample?.plantName || named?.plantName || "",
      subtypeName: sample?.subtypeName || named?.subtypeName || "",
      uncovered: orders.reduce((sum, line) => sum + line.uncovered, 0),
      pastDue: orders.filter((line) => line.pastDue).reduce((sum, line) => sum + line.total, 0),
      notDue: orders.filter((line) => !line.pastDue).reduce((sum, line) => sum + line.total, 0),
      sowingRemaining: sowings.reduce((sum, row) => sum + row.remaining, 0),
      orders,
      remainingSowings: sowings,
      generatedAt: moment().utcOffset(IST_OFFSET).toISOString(),
    });
  } catch (error) {
    console.error("getSafeZoneOrders:", error);
    return res.status(500).json({ success: false, message: "Failed to load uncovered orders" });
  }
};
