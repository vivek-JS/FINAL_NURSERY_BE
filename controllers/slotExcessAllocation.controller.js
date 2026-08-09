import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantSlot from "../models/slots.model.js";
import {
  isOfficeOrSuper,
  orderPlantsNeed,
  resolveDestinationSlot,
  applyTransfer,
  reverseTransfers,
  loadSourceSlotsByIds,
} from "./orderSowFromExcess.controller.js";
import {
  writeTransferAudit,
  writePartialTransferRecord,
} from "./sowingTransferAudit.helpers.js";
import { parseLocalDate } from "./sowingSlotReadyHelpers.js";
import { ORDER_COVER_WINDOW_DAYS } from "./sowingCompleteHelpers.js";

function dayStartMs(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function offsetLabel(off) {
  if (off === 0) return "delivery day";
  if (off > 0) return `+${off}d`;
  return `${off}d`;
}

function slotLabel(slot) {
  if (!slot) return "—";
  if (!slot.endDay || slot.startDay === slot.endDay) return slot.startDay || "—";
  return `${slot.startDay} → ${slot.endDay}`;
}

async function loadSlotContext(slotId) {
  if (!slotId || !mongoose.Types.ObjectId.isValid(String(slotId))) return null;
  const sid = new mongoose.Types.ObjectId(slotId);

  const rows = await PlantSlot.aggregate([
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $match: { "subtypeSlots.slots._id": sid } },
    {
      $project: {
        plantId: "$plantId",
        subtypeId: "$subtypeSlots.subtypeId",
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
        availablePlants: {
          $ifNull: ["$subtypeSlots.slots.availablePlants", 0],
        },
        orderReservedPlants: {
          $ifNull: ["$subtypeSlots.slots.orderReservedPlants", 0],
        },
        excessivePlants: {
          $ifNull: ["$subtypeSlots.slots.excessiveSowing.plants", 0],
        },
      },
    },
    { $limit: 1 },
  ]);

  const row = rows[0];
  if (!row) return null;

  return {
    plantId: row.plantId,
    subtypeId: row.subtypeId,
    slotId: row.slotId,
    startDay: row.startDay,
    endDay: row.endDay,
    label: slotLabel(row),
    availablePlants: Math.max(0, Number(row.availablePlants) || 0),
    orderReservedPlants: Number(row.orderReservedPlants) || 0,
    excessivePlants: Math.max(0, Number(row.excessivePlants) || 0),
  };
}

const ACTIVE_ORDER_FILTER = {
  sowingDone: { $ne: true },
  orderStatus: {
    $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"],
  },
};

/**
 * GET /sowing/slot/:slotId/coverable-orders
 */
export const getSlotCoverableOrders = async (req, res) => {
  try {
    if (!isOfficeOrSuper(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Only Office Admin or Super Admin can view coverable orders",
      });
    }

    const { slotId } = req.params;
    const source = await loadSlotContext(slotId);
    if (!source) {
      return res.status(404).json({
        success: false,
        message: "Source slot not found",
      });
    }

    const orders = await Order.find({
      plantName: source.plantId,
      plantSubtype: source.subtypeId,
      ...ACTIVE_ORDER_FILTER,
    })
      .select(
        "orderId numberOfPlants additionalPlants bookingSlot deliveryDate farmerName sowingDone"
      )
      .sort({ deliveryDate: 1, orderId: 1 })
      .lean();

    const bookingIds = [
      ...new Set(
        orders.map((o) => o.bookingSlot).filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
      ),
    ];
    const bookingMeta = new Map();
    if (bookingIds.length) {
      const slots = await PlantSlot.aggregate([
        { $match: { plantId: source.plantId } },
        { $unwind: "$subtypeSlots" },
        { $match: { "subtypeSlots.subtypeId": source.subtypeId } },
        { $unwind: "$subtypeSlots.slots" },
        {
          $match: {
            "subtypeSlots.slots._id": {
              $in: bookingIds.map((id) => new mongoose.Types.ObjectId(id)),
            },
          },
        },
        {
          $project: {
            slotId: "$subtypeSlots.slots._id",
            startDay: "$subtypeSlots.slots.startDay",
            endDay: "$subtypeSlots.slots.endDay",
          },
        },
      ]);
      for (const sl of slots) {
        bookingMeta.set(String(sl.slotId), {
          label: slotLabel(sl),
          endDay: sl.endDay || sl.startDay,
          startDay: sl.startDay,
        });
      }
    }

    const win = Math.max(
      0,
      Math.min(
        14,
        req.query.windowDays === undefined || req.query.windowDays === ""
          ? ORDER_COVER_WINDOW_DAYS
          : Number(req.query.windowDays) || ORDER_COVER_WINDOW_DAYS
      )
    );
    const windowOnly = req.query.windowOnly === "true";

    const sourceAnchor = parseLocalDate(source.endDay || source.startDay);
    const sourceMs = sourceAnchor ? dayStartMs(sourceAnchor) : null;

    let remainingSource = source.availablePlants;
    const coverableOrders = orders.map((o) => {
      const need = orderPlantsNeed(o);
      const meta = o.bookingSlot ? bookingMeta.get(String(o.bookingSlot)) : null;
      const bookingSlotLabel = meta?.label || "—";
      let offsetDays = null;
      let inCoverWindow = false;
      if (sourceMs != null) {
        const anchor =
          parseLocalDate(o.deliveryDate) ||
          parseLocalDate(meta?.endDay) ||
          parseLocalDate(meta?.startDay);
        if (anchor) {
          offsetDays = Math.round((sourceMs - dayStartMs(anchor)) / 86400000);
          inCoverWindow = offsetDays <= 0 && offsetDays >= -win;
        }
      }
      const suggestedTake = inCoverWindow
        ? Math.min(need, remainingSource)
        : 0;
      if (suggestedTake > 0) remainingSource -= suggestedTake;
      return {
        orderMongoId: String(o._id),
        orderId: o.orderId,
        farmerName: o.farmerName || "Farmer",
        plantsNeeded: need,
        deliveryDate: o.deliveryDate || null,
        bookingSlotId: o.bookingSlot ? String(o.bookingSlot) : null,
        bookingSlotLabel,
        offsetDays,
        offsetLabel: offsetDays != null ? offsetLabel(offsetDays) : null,
        inCoverWindow,
        suggestedTake,
        canFullyCover: suggestedTake >= need,
      };
    });

    const sorted = [...coverableOrders].sort(
      (a, b) =>
        Number(b.inCoverWindow) - Number(a.inCoverWindow) ||
        (b.offsetDays ?? -99) - (a.offsetDays ?? -99) ||
        b.plantsNeeded - a.plantsNeeded
    );

    const filtered = windowOnly ? sorted.filter((o) => o.inCoverWindow) : sorted;

    return res.status(200).json({
      success: true,
      data: {
        sourceSlot: {
          slotId: String(source.slotId),
          label: source.label,
          availablePlants: source.availablePlants,
          orderReservedPlants: source.orderReservedPlants,
        },
        plantId: String(source.plantId),
        subtypeId: String(source.subtypeId),
        windowDays: win,
        windowOnly,
        totalPendingOrders: orders.length,
        inWindowCount: coverableOrders.filter((o) => o.inCoverWindow).length,
        totalPlantsNeeded: filtered.reduce((s, o) => s + o.plantsNeeded, 0),
        remainingAfterSuggest: remainingSource,
        orders: filtered,
      },
    });
  } catch (error) {
    console.error("[getSlotCoverableOrders]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load coverable orders",
    });
  }
};

function buildTransferRow(source, destination, take) {
  const sameSlot = String(source.slotId) === String(destination.slotId);
  return {
    fromSlotId: source.slotId,
    fromLabel: source.label,
    toSlotId: destination.slotId,
    toLabel: destination.label,
    offsetDays: null,
    take,
    availableBefore: source.availablePlants,
    excessDec: Math.min(take, source.excessivePlants || 0),
    sameSlot,
  };
}

/**
 * POST /sowing/slot/:slotId/allocate-to-orders
 * Body: { allocations: [{ orderId, plants }] }  — orderId = Mongo _id
 */
export const allocateSlotToOrders = async (req, res) => {
  try {
    if (!isOfficeOrSuper(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Only Office Admin or Super Admin can allocate excess to orders",
      });
    }

    const { slotId } = req.params;
    const allocations = Array.isArray(req.body?.allocations)
      ? req.body.allocations
      : [];

    if (!allocations.length) {
      return res.status(400).json({
        success: false,
        message: "allocations[] is required",
      });
    }

    const source = await loadSlotContext(slotId);
    if (!source) {
      return res.status(404).json({
        success: false,
        message: "Source slot not found",
      });
    }

    const totalRequested = allocations.reduce(
      (s, a) => s + Math.max(0, Math.floor(Number(a?.plants) || 0)),
      0
    );
    if (totalRequested <= 0) {
      return res.status(400).json({
        success: false,
        message: "Each allocation needs plants > 0",
      });
    }

    const orderIds = allocations
      .map((a) => String(a?.orderId || a?.orderMongoId || ""))
      .filter((id) => mongoose.Types.ObjectId.isValid(id));

    if (!orderIds.length) {
      return res.status(400).json({
        success: false,
        message: "Valid order ids required in allocations",
      });
    }

    const orders = await Order.find({
      _id: { $in: orderIds.map((id) => new mongoose.Types.ObjectId(id)) },
      plantName: source.plantId,
      plantSubtype: source.subtypeId,
      ...ACTIVE_ORDER_FILTER,
    });

    const orderById = new Map(orders.map((o) => [String(o._id), o]));
    const results = [];
    const appliedAll = [];

    for (const raw of allocations) {
      const oid = String(raw?.orderId || raw?.orderMongoId || "");
      const plants = Math.max(0, Math.floor(Number(raw?.plants) || 0));
      if (!oid || plants <= 0) continue;

      const order = orderById.get(oid);
      if (!order) {
        results.push({
          orderId: oid,
          success: false,
          message: "Order not found or already covered / wrong plant",
        });
        continue;
      }

      const need = orderPlantsNeed(order);
      if (plants > need) {
        results.push({
          orderId: order.orderId,
          orderMongoId: oid,
          success: false,
          message: `Cannot allocate ${plants} — order needs only ${need}`,
        });
        continue;
      }

      const destination = await resolveDestinationSlot({
        plantId: order.plantName,
        subtypeId: order.plantSubtype,
        deliveryDate: order.deliveryDate,
        bookingSlotId: order.bookingSlot,
      });
      if (!destination?.slotId) {
        results.push({
          orderId: order.orderId,
          orderMongoId: oid,
          success: false,
          message: "No booking/delivery slot for order",
        });
        continue;
      }

      const [freshSource] = await loadSourceSlotsByIds({
        plantId: source.plantId,
        subtypeId: source.subtypeId,
        slotIds: [source.slotId],
      });
      const avail = freshSource?.availablePlants ?? 0;
      if (plants > avail) {
        results.push({
          orderId: order.orderId,
          orderMongoId: oid,
          success: false,
          message: `Source slot only has ${avail} available (asked ${plants})`,
        });
        continue;
      }

      const tr = buildTransferRow(
        {
          slotId: source.slotId,
          label: source.label,
          availablePlants: avail,
          excessivePlants: freshSource?.excessivePlants || 0,
        },
        destination,
        plants
      );

      const ok = await applyTransfer(tr);
      if (!ok) {
        results.push({
          orderId: order.orderId,
          orderMongoId: oid,
          success: false,
          message: "Transfer failed — stock may have changed",
        });
        continue;
      }
      appliedAll.push(tr);

      const fullyCovered = plants >= need;
      let auditRequest = null;
      try {
        if (fullyCovered) {
          auditRequest = await writeTransferAudit({
            order,
            plants,
            transfers: [tr],
            destination,
            userId: req.user._id,
            note: `Slot assign from ${source.label}`,
          });
        } else {
          await writePartialTransferRecord({
            order,
            plants,
            transfers: [tr],
            destination,
            userId: req.user._id,
          });
        }
      } catch (auditErr) {
        await reverseTransfers([tr]);
        results.push({
          orderId: order.orderId,
          orderMongoId: oid,
          success: false,
          message: auditErr.message || "Failed to record transfer",
        });
        continue;
      }

      let marked = null;
      if (fullyCovered && auditRequest) {
        const remark = [
          `Sow completed — allocated ${plants} plants from ${source.label}`,
          `→ ${destination.label}`,
          auditRequest.requestNumber ? `req ${auditRequest.requestNumber}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

        marked = await Order.findOneAndUpdate(
          { _id: order._id, sowingDone: { $ne: true } },
          {
            $set: {
              sowingDone: true,
              sowingDoneAt: new Date(),
              sowingDoneRequestId: auditRequest._id,
            },
            $push: { orderRemarks: remark },
          },
          { new: true }
        );
      }

      results.push({
        orderId: order.orderId,
        orderMongoId: oid,
        success: true,
        plantsAllocated: plants,
        plantsNeeded: need,
        sowingDone: Boolean(marked?.sowingDone),
        fullyCovered,
        destinationSlot: {
          slotId: String(destination.slotId),
          label: destination.label,
        },
      });
    }

    const anySuccess = results.some((r) => r.success);
    if (!anySuccess && appliedAll.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No allocations succeeded",
        data: { results },
      });
    }

    const [finalSource] = await loadSourceSlotsByIds({
      plantId: source.plantId,
      subtypeId: source.subtypeId,
      slotIds: [source.slotId],
    });

    return res.status(200).json({
      success: true,
      message: `Allocated plants from ${source.label} to ${results.filter((r) => r.success).length} order(s)`,
      data: {
        sourceSlot: {
          slotId: String(source.slotId),
          label: source.label,
          availablePlantsRemaining: finalSource?.availablePlants ?? 0,
        },
        results,
        transfersApplied: appliedAll.length,
      },
    });
  } catch (error) {
    console.error("[allocateSlotToOrders]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to allocate excess to orders",
    });
  }
};
