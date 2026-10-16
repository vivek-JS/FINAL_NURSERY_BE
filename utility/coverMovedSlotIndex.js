import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";

function idStr(id) {
  return id?.toString?.() ?? String(id || "");
}

function windowLabel(slot) {
  if (!slot?.startDay) return "";
  if (!slot.endDay || slot.endDay === slot.startDay) return slot.startDay;
  return `${slot.startDay}–${slot.endDay}`;
}

function emptyBucket() {
  return { orders: [], orderCount: 0, plants: 0 };
}

/**
 * Sow entries moved between slots to cover an order from excess (batch.coverMovedFrom).
 * inBySlot: booking slot → orders whose sowing came from another slot.
 * outBySlot: source slot → orders on other slots its sowing was moved to.
 * metaByOrder: order _id → source slot (for "sowed on" labels).
 */
export async function loadCoverMovedIndex(slotIds, slotMap, ordersById = new Map()) {
  const inBySlot = new Map();
  const outBySlot = new Map();
  const metaByOrder = new Map();
  const ids = (slotIds || []).map((id) => new mongoose.Types.ObjectId(idStr(id)));
  if (!ids.length) return { inBySlot, outBySlot, metaByOrder };

  const PATH = "subtypeSlots.slots.sowingBatches";
  const rows = await PlantSlot.aggregate([
    { $match: { [`${PATH}.coverMovedFrom.slotId`]: { $exists: true } } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $unwind: `$${PATH}` },
    {
      $match: {
        [`${PATH}.coverMovedFrom.slotId`]: { $exists: true },
        $or: [
          { "subtypeSlots.slots._id": { $in: ids } },
          { [`${PATH}.coverMovedFrom.slotId`]: { $in: ids } },
        ],
      },
    },
    {
      $project: {
        _id: 0,
        toSlotId: "$subtypeSlots.slots._id",
        toStartDay: "$subtypeSlots.slots.startDay",
        toEndDay: "$subtypeSlots.slots.endDay",
        batch: `$${PATH}`,
      },
    },
  ]);
  if (!rows.length) return { inBySlot, outBySlot, metaByOrder };

  const missingSlotIds = new Set();
  const missingOrderIds = new Set();
  for (const r of rows) {
    const fromId = idStr(r.batch.coverMovedFrom?.slotId);
    if (fromId && !slotMap?.has(fromId)) missingSlotIds.add(fromId);
    for (const oid of r.batch.linkedOrderIds || []) {
      if (!ordersById.has(idStr(oid))) missingOrderIds.add(idStr(oid));
    }
  }

  const extraSlots = new Map();
  if (missingSlotIds.size) {
    const found = await PlantSlot.aggregate([
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      {
        $match: {
          "subtypeSlots.slots._id": {
            $in: [...missingSlotIds].map((id) => new mongoose.Types.ObjectId(id)),
          },
        },
      },
      {
        $project: {
          _id: "$subtypeSlots.slots._id",
          startDay: "$subtypeSlots.slots.startDay",
          endDay: "$subtypeSlots.slots.endDay",
        },
      },
    ]);
    for (const s of found) extraSlots.set(idStr(s._id), s);
  }

  const orderLookup = new Map(ordersById);
  if (missingOrderIds.size) {
    const found = await Order.find({ _id: { $in: [...missingOrderIds] } })
      .select("orderId orderStatus")
      .lean();
    for (const o of found) orderLookup.set(idStr(o._id), o);
  }

  const push = (map, slotId, row) => {
    if (!map.has(slotId)) map.set(slotId, emptyBucket());
    const bucket = map.get(slotId);
    bucket.orders.push(row);
    bucket.orderCount += 1;
    bucket.plants += row.plants;
  };

  for (const r of rows) {
    const b = r.batch;
    const fromId = idStr(b.coverMovedFrom?.slotId);
    const toId = idStr(r.toSlotId);
    const fromSlot = slotMap?.get(fromId) || extraSlots.get(fromId);
    const fromSlotLabel = windowLabel(fromSlot) || (b.plantReadyDate ? `ready ${b.plantReadyDate}` : "Other slot");
    const toSlotLabel = windowLabel({ startDay: r.toStartDay, endDay: r.toEndDay });
    const plants = Math.max(0, Number(b.plantsSowed) || 0);
    const sowingNote = [
      b.sowingDate ? `Sowed ${b.sowingDate}` : null,
      b.plantReadyDate ? `ready ${b.plantReadyDate}` : null,
      b.requestNumber || null,
    ]
      .filter(Boolean)
      .join(" · ");

    for (const oid of b.linkedOrderIds || []) {
      const key = idStr(oid);
      const order = orderLookup.get(key);
      if (["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"].includes(order?.orderStatus)) continue;
      const base = {
        _id: key,
        orderId: order?.orderId ?? "—",
        orderStatus: order?.orderStatus || "",
        plants,
        sowingDate: b.sowingDate || "",
        plantReadyDate: b.plantReadyDate || "",
        requestNumber: b.requestNumber || "",
        sowingNote,
        fromSlotId: fromId,
        toSlotId: toId,
      };
      push(inBySlot, toId, { ...base, fromSlotLabel });
      push(outBySlot, fromId, { ...base, toSlotLabel });
      metaByOrder.set(key, {
        fromSlotId: fromId,
        fromSlotLabel,
        requestNumber: b.requestNumber || "",
        plantReadyDate: b.plantReadyDate || "",
        sowingNote,
      });
    }
  }

  return { inBySlot, outBySlot, metaByOrder };
}
