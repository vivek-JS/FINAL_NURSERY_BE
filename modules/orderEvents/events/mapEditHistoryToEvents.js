import { ORDER_EVENT_TYPES } from "../domain/constants.js";

const FIELD_TO_EVENT_TYPE = {
  orderStatus: ORDER_EVENT_TYPES.ORDER_STATUS_CHANGED,
  rate: ORDER_EVENT_TYPES.ORDER_RATE_CHANGED,
  numberOfPlants: ORDER_EVENT_TYPES.ORDER_QUANTITY_CHANGED,
  deliveryDate: ORDER_EVENT_TYPES.DELIVERY_DATE_CHANGED,
  bookingSlot: ORDER_EVENT_TYPES.SLOT_CHANGED,
  plantSubtype: ORDER_EVENT_TYPES.ORDER_FIELD_CHANGED,
  salesPerson: ORDER_EVENT_TYPES.ORDER_FIELD_CHANGED,
  orderPaymentStatus: ORDER_EVENT_TYPES.PAYMENT_STATUS_CHANGED,
  notes: ORDER_EVENT_TYPES.NOTES_UPDATED,
  farmReadyDate: ORDER_EVENT_TYPES.PLANT_READY_UPDATED,
  dispatchDayKey: ORDER_EVENT_TYPES.DISPATCH_UPDATED,
  dispatchTargetDate: ORDER_EVENT_TYPES.DISPATCH_UPDATED,
  cavity: ORDER_EVENT_TYPES.ORDER_FIELD_CHANGED,
  expectedNursery: ORDER_EVENT_TYPES.ORDER_FIELD_CHANGED,
  batchNumber: ORDER_EVENT_TYPES.ORDER_FIELD_CHANGED,
  freightCharges: ORDER_EVENT_TYPES.ORDER_AMOUNT_CHANGED,
  deliveryChallanInvoiceNumber: ORDER_EVENT_TYPES.ORDER_FIELD_CHANGED,
  orderFor: ORDER_EVENT_TYPES.CUSTOMER_CHANGED,
  farmer: ORDER_EVENT_TYPES.CUSTOMER_CHANGED,
  remainingPlants: ORDER_EVENT_TYPES.ORDER_QUANTITY_CHANGED,
  returnedPlants: ORDER_EVENT_TYPES.ORDER_QUANTITY_CHANGED,
  damagedPlants: ORDER_EVENT_TYPES.ORDER_QUANTITY_CHANGED,
  additionalPlants: ORDER_EVENT_TYPES.ORDER_QUANTITY_CHANGED,
  commissionRatePerPlant: ORDER_EVENT_TYPES.ORDER_FIELD_CHANGED,
};

export function fieldToOrderEventType(field) {
  if (!field) return ORDER_EVENT_TYPES.ORDER_FIELD_CHANGED;
  return FIELD_TO_EVENT_TYPE[field] || ORDER_EVENT_TYPES.ORDER_FIELD_CHANGED;
}

export function buildEventPayloadFromEditEntry(entry) {
  const eventType = fieldToOrderEventType(entry.field);
  return {
    eventType,
    field: entry.field,
    previousValue: entry.previousValue,
    newValue: entry.newValue,
    description: entry.notes || `${entry.field} changed`,
    actorId: entry.changedBy || null,
  };
}

export function buildStatusChangePayload({ previousStatus, newStatus, changedBy, reason }) {
  const eventType =
    String(newStatus).toUpperCase() === "CANCELLED"
      ? ORDER_EVENT_TYPES.ORDER_CANCELLED
      : ORDER_EVENT_TYPES.ORDER_STATUS_CHANGED;
  return {
    eventType,
    field: "orderStatus",
    previousValue: previousStatus,
    newValue: newStatus,
    description: `Status changed from ${previousStatus} to ${newStatus}`,
    actorId: changedBy || null,
    reason: reason || undefined,
  };
}

export function buildDeliveryChangePayloads(change, { changedBy } = {}) {
  const events = [];
  const reason = change.reasonForChange;
  if (change.previousDeliveryDate || change.newDeliveryDate) {
    events.push({
      eventType: ORDER_EVENT_TYPES.DELIVERY_DATE_CHANGED,
      field: "deliveryDate",
      previousValue: change.previousDeliveryDate,
      newValue: change.newDeliveryDate,
      description: "Delivery date changed",
      actorId: changedBy || change.changedBy || null,
      reason,
    });
  }
  if (change.previousSlot || change.newSlot) {
    events.push({
      eventType: ORDER_EVENT_TYPES.SLOT_CHANGED,
      field: "bookingSlot",
      previousValue: change.previousSlot,
      newValue: change.newSlot,
      description: "Booking slot changed",
      actorId: changedBy || change.changedBy || null,
      reason,
    });
  }
  return events;
}
