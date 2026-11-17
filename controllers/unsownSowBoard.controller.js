import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import { leftoverOrderIdSet } from "../services/sowingLeftoverDue.service.js";
import { UNSOWN_SOW_BOARD_STATUSES } from "../constants/sowingGapOrderStatuses.js";
import { inProgressRequestByOrderId } from "../services/sowBatchStock.service.js";
import {
  orderAlreadyCovered,
  orderPlantRemaining,
  orderPlantTotal,
  sowingStillNeedsMatch,
} from "../services/orderSowCover.plan.js";

const ACTIVE_ORDER_STATUSES = UNSOWN_SOW_BOARD_STATUSES;

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
 * Accepted orders that still need sowing.
 * Cover truth = sowingCoverSources across ALL slots/SRs (else partial holds).
 *   stillNeed > 0 → show (need / partial)
 *   fully covered on other slots → hide (even if sowingDone flag is wrong)
 * sowingDone flag is NOT used to hide — sources decide.
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
      return res.json({
        success: true,
        data: [],
        counts: { need: 0, partial: 0, progress: 0, late: 0 },
        truncated: false,
      });
    }

    const [orders, leftoverIds] = await Promise.all([
      Order.find({
        plantName: { $in: plantIds },
        orderStatus: { $in: ACTIVE_ORDER_STATUSES },
        dealerOrder: { $ne: true },
        productMappingId: null,
        ...sowingStillNeedsMatch(),
      })
        .select(
          "orderId name farmer plantName plantSubtype plantNameSnapshot plantSubtypeSnapshot bookingSlot numberOfPlants additionalPlants sowingPartialCover sowingCoverSources leftoverFromIncomplete deliveryDate sowingDone"
        )
        .populate("farmer", "name")
        .limit(ROW_CAP)
        .lean(),
      leftoverOrderIdSet(),
    ]);
    const progressByOrder = await inProgressRequestByOrderId(orders.map((order) => order._id));

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
      const booked = orderPlantTotal(order);
      const covered = orderAlreadyCovered(order);
      // Sources across slots = truth. Do NOT use dispatch remainingPlants.
      const remaining = orderPlantRemaining(order);
      const leftover =
        leftoverIds.has(String(order._id)) || Boolean(order.leftoverFromIncomplete);
      const requestNumber = progressByOrder.get(String(order._id));
      const inProgress = requestNumber != null;
      const partial = covered > 0 || leftover || (remaining > 0 && remaining < booked);
      if (!inProgress && !partial && remaining <= 0) continue;

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
        status: inProgress ? "progress" : partial ? "partial" : "need",
        requestNumber: requestNumber || "",
        deliveryDate: order.deliveryDate || null,
        sowByDate,
        readyDate: windowMs != null ? dmy(windowMs) : null,
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
        else if (row.status === "progress") acc.progress += 1;
        else acc.need += 1;
        if (row.daysUntilSow != null && row.daysUntilSow < 0) acc.late += 1;
        return acc;
      },
      { need: 0, partial: 0, progress: 0, late: 0 }
    );

    // Full variety/subtype catalog (CMS) so filters list every subtype — not only ones with open rows.
    const openByKey = new Map();
    for (const row of rows) {
      const key = `${row.plantId}|${row.subtypeId}`;
      openByKey.set(key, (openByKey.get(key) || 0) + 1);
    }
    const plantCatalog = plants
      .map((plant) => ({
        id: String(plant._id),
        name: plant.name || "",
        subtypes: (plant.subtypes || [])
          .map((subtype) => {
            const id = String(subtype._id);
            return {
              id,
              name: subtype.name || "",
              openOrders: openByKey.get(`${String(plant._id)}|${id}`) || 0,
            };
          })
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return res.json({
      success: true,
      data: rows,
      counts,
      plants: plantCatalog,
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
