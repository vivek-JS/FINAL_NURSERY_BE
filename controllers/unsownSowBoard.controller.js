import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import { leftoverOrderIdSet } from "../services/sowingLeftoverDue.service.js";

const ACTIVE_ORDER_STATUSES = [
  "PENDING",
  "PROCESSING",
  "ACCEPTED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

const ROW_CAP = 2500;

const MONTH_INDEX = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
  april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
  august: 7, aug: 7, september: 8, sep: 8, sept: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};

function slotStartMs(day, month, year) {
  const d = parseInt(day, 10);
  const y = Number(year);
  const m = MONTH_INDEX[String(month || "").trim().toLowerCase()];
  if (!Number.isFinite(d) || !Number.isFinite(y) || m == null) return null;
  return Date.UTC(y, m, d);
}

function todayIstMs() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const pick = (type) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(pick("year"), pick("month") - 1, pick("day"));
}

function dmy(ms) {
  const sd = new Date(ms);
  const dd = String(sd.getUTCDate()).padStart(2, "0");
  const mm = String(sd.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${sd.getUTCFullYear()}`;
}

function heldPlants(order) {
  const rows = Array.isArray(order.sowingPartialCover) ? order.sowingPartialCover : [];
  return rows.reduce((sum, row) => sum + (Number(row.plants) || 0), 0);
}

async function slotMetaById(slotIds) {
  const map = new Map();
  if (!slotIds.length) return map;
  const docs = await PlantSlot.find({ "subtypeSlots.slots._id": { $in: slotIds } })
    .select(
      "year subtypeSlots.slots._id subtypeSlots.slots.startDay subtypeSlots.slots.endDay subtypeSlots.slots.month subtypeSlots.slots.year subtypeSlots.slots.plantReadyDays"
    )
    .lean();
  const wanted = new Set(slotIds.map(String));
  for (const doc of docs) {
    for (const group of doc.subtypeSlots || []) {
      for (const slot of group.slots || []) {
        const id = String(slot._id);
        if (!wanted.has(id)) continue;
        map.set(id, {
          startDay: slot.startDay || "",
          endDay: slot.endDay || "",
          month: slot.month,
          year: slot.year || doc.year,
          plantReadyDays: Number(slot.plantReadyDays) || 0,
        });
      }
    }
  }
  return map;
}

/**
 * Every accepted order that still needs sowing or is only partly covered.
 * Sorted by sow-by date (most late first). Variety filters are derived on the client.
 */
export const getUnsownSowBoard = async (req, res) => {
  try {
    const plants = await PlantCms.find({ sowingAllowed: true })
      .select("name subtypes._id subtypes.name subtypes.plantReadyDays")
      .lean();

    const plantById = new Map();
    for (const plant of plants) {
      const subtypes = new Map();
      for (const subtype of plant.subtypes || []) {
        subtypes.set(String(subtype._id), {
          name: subtype.name || "",
          plantReadyDays: Number(subtype.plantReadyDays) || 0,
        });
      }
      plantById.set(String(plant._id), { name: plant.name || "", subtypes });
    }

    const plantIds = plants.map((plant) => plant._id);
    if (!plantIds.length) {
      return res.json({ success: true, data: [], counts: { need: 0, partial: 0, late: 0 }, truncated: false });
    }

    const [orders, leftoverIds] = await Promise.all([
      Order.find({
        plantName: { $in: plantIds },
        orderStatus: { $in: ACTIVE_ORDER_STATUSES },
        sowingDone: { $ne: true },
        dealerOrder: { $ne: true },
        productMappingId: null,
      })
        .select(
          "orderId name farmer plantName plantSubtype plantNameSnapshot plantSubtypeSnapshot bookingSlot numberOfPlants additionalPlants sowingPartialCover deliveryDate"
        )
        .populate("farmer", "name")
        .limit(ROW_CAP)
        .lean(),
      leftoverOrderIdSet(),
    ]);

    const slotIds = [
      ...new Set(
        orders
          .map((order) => order.bookingSlot)
          .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
          .map(String)
      ),
    ].map((id) => new mongoose.Types.ObjectId(id));
    const slots = await slotMetaById(slotIds);
    const today = todayIstMs();

    const rows = [];
    for (const order of orders) {
      const plant = plantById.get(String(order.plantName));
      if (!plant) continue;
      const subtype = plant.subtypes.get(String(order.plantSubtype));
      const booked = (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0);
      const covered = heldPlants(order);
      const remaining = Math.max(0, booked - covered);
      const leftover = leftoverIds.has(String(order._id));
      const partial = covered > 0 || leftover;
      if (!partial && remaining <= 0) continue;

      const slot = slots.get(String(order.bookingSlot)) || null;
      const readyDays = Number(slot?.plantReadyDays) || subtype?.plantReadyDays || 0;
      const windowMs = slot ? slotStartMs(slot.startDay, slot.month, slot.year) : null;
      let daysUntilSow = null;
      let sowByDate = null;
      if (windowMs != null) {
        const sowByMs = windowMs - readyDays * 86400000;
        daysUntilSow = Math.floor((sowByMs - today) / 86400000);
        sowByDate = dmy(sowByMs);
      }

      rows.push({
        orderId: order._id,
        orderNumber: order.orderId,
        farmerName: order.farmer?.name || order.name || "",
        plantId: String(order.plantName),
        plantName: plant.name || order.plantNameSnapshot || "",
        subtypeId: String(order.plantSubtype || ""),
        subtypeName: subtype?.name || order.plantSubtypeSnapshot || "",
        bookedPlants: booked,
        coveredPlants: covered,
        remainingPlants: remaining,
        status: partial ? "partial" : "need",
        deliveryDate: order.deliveryDate || null,
        sowByDate,
        daysUntilSow,
        slotStart: slot?.startDay || "",
        slotEnd: slot?.endDay || "",
      });
    }

    rows.sort(
      (a, b) =>
        (a.daysUntilSow ?? 99999) - (b.daysUntilSow ?? 99999) ||
        String(a.sowByDate || "").localeCompare(String(b.sowByDate || "")) ||
        (Number(a.orderNumber) || 0) - (Number(b.orderNumber) || 0)
    );

    const counts = rows.reduce(
      (acc, row) => {
        if (row.status === "partial") acc.partial += 1;
        else acc.need += 1;
        if (row.daysUntilSow != null && row.daysUntilSow < 0) acc.late += 1;
        return acc;
      },
      { need: 0, partial: 0, late: 0 }
    );

    return res.json({
      success: true,
      data: rows,
      counts,
      truncated: orders.length >= ROW_CAP,
    });
  } catch (error) {
    console.error("getUnsownSowBoard:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load not-sown orders",
    });
  }
};
