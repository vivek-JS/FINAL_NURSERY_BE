import mongoose from "mongoose";
import Order from "../models/order.model.js";
import "../models/farmer.model.js";
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

/**
 * Batch-wise order dispatch for a booking slot.
 * Ledger lines are matched by order id (not linkedBookingSlotId) because load
 * often records the shed/source slot while the order stays on the delivery slot.
 */
export async function getSlotOrderDispatchByBatch(slotId) {
  if (!slotId || !mongoose.isValidObjectId(String(slotId))) {
    return null;
  }
  const slotOid = new mongoose.Types.ObjectId(String(slotId));

  const orders = await Order.find({ bookingSlot: slotOid })
    .select(
      "_id orderId numberOfPlants orderStatus dispatchHistory farmer bookingSlot"
    )
    .populate("farmer", "name")
    .lean();

  const orderById = new Map(orders.map((o) => [String(o._id), o]));
  const orderIds = orders.map((o) => String(o._id));

  const linesCol = mongoose.connection.collection(
    SECONDARY_DISPATCH_LEDGER_COLLECTIONS.LINES
  );

  const ledgerLines =
    orderIds.length > 0
      ? await linesCol
          .find({
            linkedOrderId: { $in: orderIds },
            action: LOAD,
          })
          .sort({ createdAt: -1 })
          .toArray()
      : [];

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
        dispatchedPlants: 0,
        orderIds: new Set(),
        orders: [],
        ledgerLineCount: 0,
      });
    }
    const g = batchMap.get(batchNumber);
    g.dispatchedPlants += plants;
    g.ledgerLineCount += 1;
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
      dispatchedPlants: g.dispatchedPlants,
      orderCount: g.orderIds.size,
      ledgerLineCount: g.ledgerLineCount,
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
      linkedBookingSlotId: ln.linkedBookingSlotId
        ? String(ln.linkedBookingSlotId)
        : null,
      createdAt: ln.createdAt ?? null,
      metadata: ln.metadata ?? null,
    };
  });

  return {
    slotId: String(slotId),
    summary: {
      orderCount: orders.length,
      dispatchedOrderCount,
      totalOrderDispatchedPlants,
      totalLedgerPlants,
      ledgerLineCount: ledgerLines.length,
      batchCount: byBatch.length,
    },
    byBatch,
    items,
    ordersWithoutLedger,
  };
}
