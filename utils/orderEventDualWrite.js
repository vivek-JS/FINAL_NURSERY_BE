import {
  ORDER_DOMAINS,
  ORDER_EVENT_TYPES,
  ORDER_EVENT_SOURCE,
  emitOrderEvent,
  emitOrderEventsFromEditHistory,
  emitOrderStatusChangeEvent,
  buildIdempotencyKey,
} from "../modules/orderEvents/index.js";
import { buildDeliveryChangePayloads } from "../modules/orderEvents/events/mapEditHistoryToEvents.js";

export async function emitPlantOrderCreatedEvents(order, { userId, actorName, session } = {}) {
  if (!order?._id) return;
  const orderId = order._id;
  await emitOrderEvent(
    {
      orderDomain: ORDER_DOMAINS.PLANT,
      orderId,
      eventType: ORDER_EVENT_TYPES.ORDER_CREATED,
      idempotencyKey: buildIdempotencyKey("plant", "created", orderId),
      description: `Order #${order.orderId ?? orderId} created`,
      actorId: userId,
      actorName,
      newValue: {
        orderStatus: order.orderStatus,
        numberOfPlants: order.numberOfPlants,
        rate: order.rate,
      },
      occurredAt: order.createdAt || new Date(),
    },
    { session }
  );

  if (order.bookingSlot) {
    await emitOrderEvent(
      {
        orderDomain: ORDER_DOMAINS.PLANT,
        orderId,
        eventType: ORDER_EVENT_TYPES.INVENTORY_RESERVED,
        idempotencyKey: buildIdempotencyKey("plant", "inventory-reserved", orderId),
        description: "Slot capacity reserved for order",
        actorId: userId,
        actorName,
        refs: { slotId: order.bookingSlot },
        newValue: { quantity: order.numberOfPlants, slotId: order.bookingSlot },
        occurredAt: order.createdAt || new Date(),
      },
      { session }
    );
  }
}

export async function emitPlantOrderUpdateEvents(
  {
    orderId,
    editHistoryEntries = [],
    deliveryChange,
    statusChangePush,
    userId,
    actorName,
    correlationId,
  },
  { session } = {}
) {
  if (!orderId) return;

  if (editHistoryEntries.length > 0) {
    await emitOrderEventsFromEditHistory(
      {
        orderDomain: ORDER_DOMAINS.PLANT,
        orderId,
        entries: editHistoryEntries,
        actorId: userId,
        actorName,
        correlationId,
        source: ORDER_EVENT_SOURCE.LIVE,
      },
      { session }
    );
  }

  if (deliveryChange) {
    const payloads = buildDeliveryChangePayloads(deliveryChange, {
      changedBy: userId,
    });
    for (let i = 0; i < payloads.length; i++) {
      const p = payloads[i];
      await emitOrderEvent(
        {
          orderDomain: ORDER_DOMAINS.PLANT,
          orderId,
          ...p,
          actorId: userId,
          actorName,
          correlationId,
          idempotencyKey: buildIdempotencyKey(
            "plant",
            "delivery",
            orderId,
            p.eventType,
            Date.now(),
            i
          ),
        },
        { session }
      );
    }
  }

  if (
    statusChangePush?.previousStatus &&
    statusChangePush?.newStatus &&
    !editHistoryEntries.some((e) => e.field === "orderStatus")
  ) {
    await emitOrderStatusChangeEvent(
      {
        orderDomain: ORDER_DOMAINS.PLANT,
        orderId,
        previousStatus: statusChangePush.previousStatus,
        newStatus: statusChangePush.newStatus,
        changedBy: userId,
        actorName,
        reason: statusChangePush.reason,
        correlationId,
      },
      { session }
    );
  }
}

export async function emitDispatchCompletedEvent(
  orderId,
  dispatchHistoryEntry,
  { userId, actorName, correlationId } = {}
) {
  if (!orderId || !dispatchHistoryEntry) return;
  await emitOrderEvent({
    orderDomain: ORDER_DOMAINS.PLANT,
    orderId,
    eventType: ORDER_EVENT_TYPES.DISPATCH_COMPLETED,
    idempotencyKey: buildIdempotencyKey(
      "plant",
      "dispatch",
      orderId,
      dispatchHistoryEntry.dispatchId || Date.now()
    ),
    description: `Dispatched ${dispatchHistoryEntry.quantity} plants`,
    actorId: dispatchHistoryEntry.processedBy || userId,
    actorName,
    newValue: dispatchHistoryEntry,
    refs: {
      dispatchId: dispatchHistoryEntry.dispatchId,
      plantOutwardId: dispatchHistoryEntry.plantOutwardId,
    },
    correlationId,
    occurredAt: dispatchHistoryEntry.date || new Date(),
  });
}

export async function emitPlantPaymentEvent(
  orderId,
  payment,
  { eventType = ORDER_EVENT_TYPES.PAYMENT_ADDED, userId, actorName } = {}
) {
  if (!orderId || !payment) return;
  const paymentId = payment._id || payment.id;
  await emitOrderEvent({
    orderDomain: ORDER_DOMAINS.PLANT,
    orderId,
    eventType,
    idempotencyKey: buildIdempotencyKey("plant", "payment", orderId, paymentId),
    description: `Payment ₹${payment.paidAmount} (${payment.paymentStatus})`,
    actorId: userId,
    actorName,
    previousValue: null,
    newValue: {
      paidAmount: payment.paidAmount,
      paymentStatus: payment.paymentStatus,
      modeOfPayment: payment.modeOfPayment,
    },
    refs: { paymentId },
    occurredAt: payment.paymentDate || new Date(),
  });
}

export async function emitPlantSplitEvents(
  parentId,
  childId,
  { splitHistoryEntry, userId, actorName, isChild, assignHistoryEntry } = {}
) {
  const orderId = isChild ? childId : parentId;
  await emitOrderEvent({
    orderDomain: ORDER_DOMAINS.PLANT,
    orderId,
    eventType: ORDER_EVENT_TYPES.ORDER_SPLIT,
    idempotencyKey: buildIdempotencyKey(
      "plant",
      "split",
      isChild ? "child" : "parent",
      orderId,
      splitHistoryEntry?.relatedOrderId
    ),
    description: isChild
      ? `Child order created from split`
      : `Split ${splitHistoryEntry?.splitQuantity} plants to new order`,
    actorId: userId || splitHistoryEntry?.performedBy,
    actorName,
    previousValue: splitHistoryEntry?.originalQuantity,
    newValue: splitHistoryEntry?.quantityAfterSplit,
    refs: { relatedOrderId: splitHistoryEntry?.relatedOrderId },
    metadata: splitHistoryEntry,
  });

  if (isChild && assignHistoryEntry) {
    await emitOrderEventsFromEditHistory({
      orderDomain: ORDER_DOMAINS.PLANT,
      orderId,
      entries: [assignHistoryEntry],
      actorId: userId || assignHistoryEntry.changedBy,
      actorName,
      source: ORDER_EVENT_SOURCE.LIVE,
    });
  }
}

/** Agri: push activityLog and mirror to OrderEvent. */
export function pushAgriActivityAndEmit(order, entry, { userId, actorName, correlationId } = {}) {
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push(entry);

  const orderId = order._id;
  const index = order.activityLog.length - 1;
  const eventType = entry.action || ORDER_EVENT_TYPES.ORDER_UPDATED;

  emitOrderEvent({
    orderDomain: ORDER_DOMAINS.AGRI,
    orderId,
    eventType,
    idempotencyKey: buildIdempotencyKey("agri", "activity", orderId, index, entry.action),
    description: entry.description,
    previousValue: entry.previousValue,
    newValue: entry.newValue,
    actorId: entry.performedBy || userId,
    actorName: entry.performedByName || actorName,
    metadata: entry.metadata,
    correlationId,
    occurredAt: new Date(),
  }).catch((e) => {
    console.error("[OrderEvent] Agri activity emit failed:", e?.message || e);
  });
}
