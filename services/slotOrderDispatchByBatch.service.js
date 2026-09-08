import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import {
  SECONDARY_DISPATCH_LEDGER_ACTIONS,
  SECONDARY_DISPATCH_LEDGER_COLLECTIONS,
} from "../utils/secondaryDispatchLedger.js";

const LOAD = SECONDARY_DISPATCH_LEDGER_ACTIONS.LOAD;

function orderDispatchedPlants(order) {
  const status = String(order?.orderStatus || "");
  const plants = Math.max(0, Number(order?.numberOfPlants) || 0);
  if (status === "DISPATCHED" || status === "COMPLETED") return plants;
  const hist = Array.isArray(order?.dispatchHistory) ? order.dispatchHistory : [];
  const fromHist = hist.reduce(
    (s, h) => s + Math.max(0, Number(h?.quantity) || 0),
    0
  );
  return fromHist;
}

async function collectSlotSecondaryInwardIds(slotId) {
  const slotOid = new mongoose.Types.ObjectId(String(slotId));
  const pos = await PlantOutward.find({
    "secondaryInward.linkedBookingSlotId": slotOid,
  })
    .select("secondaryInward._id secondaryInward.linkedBookingSlotId")
    .lean();

  const inwardIds = new Set();
  for (const po of pos || []) {
    for (const si of po.secondaryInward || []) {
      if (String(si.linkedBookingSlotId) !== String(slotId)) continue;
      if (si._id) inwardIds.add(String(si._id));
    }
  }
  return [...inwardIds];
}

function buildLedgerFilter(orderIds, slotInwardIds) {
  const or = [];
  if (orderIds.length) {
    or.push({ linkedOrderId: { $in: orderIds } });
    const oids = orderIds
      .filter((id) => mongoose.isValidObjectId(String(id)))
      .map((id) => new mongoose.Types.ObjectId(String(id)));
    if (oids.length) or.push({ linkedOrderId: { $in: oids } });
  }
  if (slotInwardIds.length) {
    or.push({ secondaryInwardId: { $in: slotInwardIds } });
  }
  if (!or.length) return null;
  return { action: LOAD, ...(or.length === 1 ? or[0] : { $or: or }) };
}

/**
 * Batch-wise dispatch outflow for a slot — ledger LOAD grouped by batch number.
 * Matches orders on the booking slot and/or secondary inward lines synced to the slot.
 * Ledger stores linkedOrderId as strings (see buildDispatchLedgerLines).
 */
export async function getSlotOrderDispatchByBatch(slotId) {
  if (!slotId || !mongoose.isValidObjectId(String(slotId))) {
    return null;
  }
  const slotOid = new mongoose.Types.ObjectId(String(slotId));
  const bookingSlotId = String(slotId);

  const [orders, slotInwardIds] = await Promise.all([
    Order.find({ bookingSlot: slotOid })
      .select(
        "_id orderId numberOfPlants orderStatus dispatchHistory farmer bookingSlot"
      )
      .populate("farmer", "name")
      .lean(),
    collectSlotSecondaryInwardIds(bookingSlotId),
  ]);

  const orderById = new Map(orders.map((o) => [String(o._id), o]));
  const orderIds = orders.map((o) => String(o._id));

  const linesCol = mongoose.connection.collection(
    SECONDARY_DISPATCH_LEDGER_COLLECTIONS.LINES
  );

  const ledgerFilter = buildLedgerFilter(orderIds, slotInwardIds);
  const ledgerLines = ledgerFilter
    ? await linesCol.find(ledgerFilter).sort({ createdAt: -1 }).toArray()
    : [];

  const missingOrderIds = [
    ...new Set(
      ledgerLines
        .map((ln) => (ln.linkedOrderId ? String(ln.linkedOrderId) : null))
        .filter((id) => id && !orderById.has(id))
    ),
  ];
  if (missingOrderIds.length) {
    const extraOrders = await Order.find({
      _id: {
        $in: missingOrderIds
          .filter((id) => mongoose.isValidObjectId(id))
          .map((id) => new mongoose.Types.ObjectId(id)),
      },
    })
      .select(
        "_id orderId numberOfPlants orderStatus dispatchHistory farmer bookingSlot"
      )
      .populate("farmer", "name")
      .lean();
    for (const order of extraOrders) {
      orderById.set(String(order._id), order);
    }
  }

  const batchMap = new Map();
  let totalLedgerPlants = 0;

  for (const ln of ledgerLines) {
    const batchNumber = ln.batchNumber || "—";
    const plants = Math.max(0, Number(ln.plantsAbs) || 0);
    totalLedgerPlants += plants;
    const order = ln.linkedOrderId ? orderById.get(String(ln.linkedOrderId)) : null;

    if (!batchMap.has(batchNumber)) {
      batchMap.set(batchNumber, {
        batchNumber,
        batchId: ln.batchId ? String(ln.batchId) : null,
        dispatchedPlants: 0,
        orderIds: new Set(),
        orders: [],
        outflowLines: [],
        ledgerLineCount: 0,
      });
    }
    const g = batchMap.get(batchNumber);
    g.dispatchedPlants += plants;
    g.ledgerLineCount += 1;

    const outLine = {
      ledgerLineId: ln._id ? String(ln._id) : null,
      orderMongoId: order ? String(order._id) : null,
      orderNumber: order?.orderId ?? null,
      farmerName:
        order?.farmer && typeof order.farmer === "object"
          ? order.farmer.name ?? null
          : null,
      orderStatus: order?.orderStatus ?? null,
      plantsOut: plants,
      pollyhouse: ln.pollyhouse ?? ln.metadata?.pollyhouse ?? null,
      secondaryInwardId: ln.secondaryInwardId ? String(ln.secondaryInwardId) : null,
      createdAt: ln.createdAt ?? null,
    };
    g.outflowLines.push(outLine);

    if (order) {
      g.orderIds.add(String(order._id));
      g.orders.push({
        orderMongoId: String(order._id),
        orderNumber: order.orderId ?? null,
        farmerName:
          order.farmer && typeof order.farmer === "object"
            ? order.farmer.name ?? null
            : null,
        orderStatus: order.orderStatus,
        ledgerPlants: plants,
        pollyhouse: ln.pollyhouse ?? ln.metadata?.pollyhouse ?? null,
        secondaryInwardId: ln.secondaryInwardId
          ? String(ln.secondaryInwardId)
          : null,
        createdAt: ln.createdAt ?? null,
      });
    }
  }

  let totalOrderDispatchedPlants = 0;
  let dispatchedOrderCount = 0;
  const ordersWithoutLedger = [];

  for (const order of orders) {
    const dispatched = orderDispatchedPlants(order);
    if (dispatched < 1) continue;
    dispatchedOrderCount += 1;
    totalOrderDispatchedPlants += dispatched;
    const hasLedger = ledgerLines.some(
      (ln) => String(ln.linkedOrderId) === String(order._id)
    );
    if (!hasLedger) {
      ordersWithoutLedger.push({
        orderMongoId: String(order._id),
        orderNumber: order.orderId ?? null,
        farmerName:
          order.farmer && typeof order.farmer === "object"
            ? order.farmer.name ?? null
            : null,
        orderStatus: order.orderStatus,
        dispatchedPlants: dispatched,
      });
    }
  }

  const byBatch = [...batchMap.values()]
    .map((g) => ({
      batchNumber: g.batchNumber,
      batchId: g.batchId,
      dispatchedPlants: g.dispatchedPlants,
      orderCount: g.orderIds.size,
      ledgerLineCount: g.ledgerLineCount,
      outflowLines: g.outflowLines,
      orders: g.orders,
    }))
    .sort((a, b) => b.dispatchedPlants - a.dispatchedPlants);

  const items = ledgerLines.map((ln) => {
    const order = ln.linkedOrderId ? orderById.get(String(ln.linkedOrderId)) : null;
    return {
      ledgerLineId: ln._id ? String(ln._id) : null,
      linkedOrderId: ln.linkedOrderId ? String(ln.linkedOrderId) : null,
      orderNumber: order?.orderId ?? null,
      farmerName:
        order?.farmer && typeof order.farmer === "object"
          ? order.farmer.name ?? null
          : null,
      batchNumber: ln.batchNumber ?? null,
      batchId: ln.batchId ? String(ln.batchId) : null,
      secondaryInwardId: ln.secondaryInwardId ? String(ln.secondaryInwardId) : null,
      pollyhouse: ln.pollyhouse ?? ln.metadata?.pollyhouse ?? null,
      plantsAbs: Math.max(0, Number(ln.plantsAbs) || 0),
      createdAt: ln.createdAt ?? null,
      metadata: ln.metadata ?? null,
    };
  });

  return {
    slotId: bookingSlotId,
    summary: {
      orderCount: orders.length,
      dispatchedOrderCount,
      totalOrderDispatchedPlants,
      totalLedgerPlants,
      ledgerLineCount: ledgerLines.length,
      batchCount: byBatch.length,
      slotInwardLineCount: slotInwardIds.length,
    },
    byBatch,
    items,
    ordersWithoutLedger,
  };
}
