import {
  emitFinancialEventShadow,
  emitFinancialEventShadowAwait,
} from "../events/emitFinancialEvent.js";
import { FINANCIAL_EVENT_TYPES } from "../domain/constants.js";
import { roundMoney } from "../domain/roundMoney.js";

/** Live shadow (async) or backfill replay (awaitPost: true). */
function shadowEmit(params, options) {
  const body = {
    ...params,
    entryDate: options?.entryDate ?? params.entryDate,
    orderEventId: options?.orderEventId ?? params.orderEventId,
  };
  if (options?.awaitPost) {
    return emitFinancialEventShadowAwait(body);
  }
  emitFinancialEventShadow(body);
  return undefined;
}

export function shadowFarmerOrderCreated({ order, customerMobile, userId }, options = {}) {
  const amount = roundMoney(
    (Number(order?.rate) || 0) *
      ((Number(order?.numberOfPlants) || 0) + (Number(order?.additionalPlants) || 0))
  );
  if (amount <= 0) return;
  return shadowEmit({
    idempotencyKey: `farmer:order:${order._id}:create`,
    eventType: FINANCIAL_EVENT_TYPES.FARMER_ORDER_CREATED,
    sourceDomain: "Order",
    sourceId: order._id,
    entryDate: order.orderBookingDate || order.createdAt,
    createdBy: userId,
    payload: {
      amount,
      partyId: customerMobile,
      customerMobile,
      sourceLineRef: `order:${order._id}`,
      description: `Order ${order.orderId ?? order._id}`,
      metadata: { orderNumericId: order.orderId },
    },
  }, options);
}

export function shadowFarmerPayment({ order, payment, customerMobile, previousStatus, newStatus, userId }, options = {}) {
  const amount = roundMoney(payment?.paidAmount);
  if (amount <= 0) return;
  const isCollected = newStatus === "COLLECTED";
  const wasCollected = previousStatus === "COLLECTED";
  if (isCollected && !wasCollected) {
    return shadowEmit({
      idempotencyKey: `farmer:payment:${payment._id}:collected`,
      eventType: FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_COLLECTED,
      sourceDomain: "Order",
      sourceId: order._id,
      entryDate: payment.paymentDate || new Date(),
      createdBy: userId,
      payload: {
        amount,
        partyId: customerMobile,
        customerMobile,
        modeOfPayment: payment.modeOfPayment,
        sourceLineRef: `payment:${payment._id}`,
      },
    }, options);
  } else if (wasCollected && !isCollected) {
    return shadowEmit({
      idempotencyKey: `farmer:payment:${payment._id}:rev:${newStatus}`,
      eventType: FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_REVERSED,
      sourceDomain: "Order",
      sourceId: order._id,
      entryDate: payment.paymentDate || new Date(),
      createdBy: userId,
      payload: {
        amount,
        partyId: customerMobile,
        customerMobile,
        modeOfPayment: payment.modeOfPayment,
        sourceLineRef: `payment:${payment._id}:rev`,
      },
    }, options);
  }
}

export function shadowFarmerOrderDelta({ order, customerMobile, deltaAmount, isIncrease, transitionKey, userId, entryDate }, options = {}) {
  const amount = roundMoney(Math.abs(deltaAmount));
  if (amount <= 0) return;
  return shadowEmit({
    idempotencyKey: `farmer:order:${order._id}:delta:${transitionKey}`,
    eventType: FINANCIAL_EVENT_TYPES.FARMER_ORDER_DELTA,
    sourceDomain: "Order",
    sourceId: order._id,
    entryDate: entryDate || new Date(),
    createdBy: userId,
    payload: {
      amount,
      isIncrease,
      partyId: customerMobile,
      customerMobile,
      sourceLineRef: transitionKey,
    },
  }, options);
}

export function shadowFarmerOrderReopen({ order, customerMobile, amount, userId, transitionKey }, options = {}) {
  const amt = roundMoney(amount);
  if (amt <= 0) return;
  return shadowEmit({
    idempotencyKey: `farmer:order:${order._id}:reopen:${transitionKey}`,
    eventType: FINANCIAL_EVENT_TYPES.FARMER_ORDER_REOPEN,
    sourceDomain: "Order",
    sourceId: order._id,
    createdBy: userId,
    payload: { amount: amt, partyId: customerMobile, customerMobile },
  }, options);
}

export function shadowFarmerOrderCancel({ order, customerMobile, amount, userId, transitionKey }, options = {}) {
  const amt = roundMoney(amount);
  if (amt <= 0) return;
  return shadowEmit({
    idempotencyKey: `farmer:order:${order._id}:${transitionKey || "cancel"}`,
    eventType: FINANCIAL_EVENT_TYPES.FARMER_ORDER_CANCEL,
    sourceDomain: "Order",
    sourceId: order._id,
    createdBy: userId,
    payload: { amount: amt, partyId: customerMobile, customerMobile },
  }, options);
}

export function shadowFarmerDispatchReturn({ order, customerMobile, amount, transitionKey, userId }, options = {}) {
  const amt = roundMoney(amount);
  if (amt <= 0) return;
  return shadowEmit({
    idempotencyKey: `farmer:order:${order._id}:${transitionKey}`,
    eventType: FINANCIAL_EVENT_TYPES.FARMER_DISPATCH_RETURN,
    sourceDomain: "Order",
    sourceId: order._id,
    createdBy: userId,
    payload: { amount: amt, partyId: customerMobile, customerMobile, sourceLineRef: transitionKey },
  }, options);
}

export function shadowFarmerAdvanceTransfer({ transferId, direction, amount, customerMobile, userId }, options = {}) {
  const amt = roundMoney(amount);
  if (amt <= 0) return;
  return shadowEmit({
    idempotencyKey: `farmer:advance:${transferId}:${direction}`,
    eventType: FINANCIAL_EVENT_TYPES.FARMER_ADVANCE_TRANSFER,
    sourceDomain: "FarmerPlantLedger",
    sourceId: transferId,
    createdBy: userId,
    payload: { amount: amt, direction, partyId: customerMobile, customerMobile },
  }, options);
}

export function shadowFarmerPaymentTransfer({ requestId, direction, amount, customerMobile, userId }, options = {}) {
  const amt = roundMoney(amount);
  if (amt <= 0) return;
  return shadowEmit({
    idempotencyKey: `farmer:payxfer:${requestId}:${direction}`,
    eventType: FINANCIAL_EVENT_TYPES.FARMER_PAYMENT_TRANSFER,
    sourceDomain: "FarmerPlantLedger",
    sourceId: requestId,
    createdBy: userId,
    payload: { amount: amt, direction, partyId: customerMobile, customerMobile },
  }, options);
}

export function shadowFarmerManualAdjustment({ entryId, amount, isDebit, customerMobile, userId }, options = {}) {
  const amt = roundMoney(amount);
  if (amt <= 0) return;
  return shadowEmit({
    idempotencyKey: `farmer:manual:${entryId}`,
    eventType: FINANCIAL_EVENT_TYPES.FARMER_MANUAL_ADJUSTMENT,
    sourceDomain: "FarmerPlantLedger",
    sourceId: entryId,
    createdBy: userId,
    payload: { amount: amt, isDebit, partyId: customerMobile, customerMobile },
  }, options);
}

/**
 * Map a Ram Agri sub-ledger row to central shadow posting.
 */
export async function shadowAgriFromLedgerRow({ entry, createdBy, previousStatus, newStatus, payment }, options = {}) {
  if (!entry) return;
  const orderStub = {
    _id: entry.orderId,
    customerMobile: entry.customerMobile,
    totalAmount: entry.debit || entry.credit,
  };
  const amt = roundMoney(entry.debit || entry.credit);
  if (amt <= 0) return;

  if (entry.refType === "ORDER") {
    return shadowAgriOrderCreated({ order: orderStub, userId: createdBy }, options);
  }
  if (entry.refType === "PAYMENT" && payment) {
    return shadowAgriPayment(
      {
        order: orderStub,
        payment,
        previousStatus: previousStatus ?? null,
        newStatus: newStatus ?? "COLLECTED",
        userId: createdBy,
      },
      options
    );
  }
  if (entry.refType === "REVERSAL" && payment) {
    return shadowAgriPayment(
      {
        order: orderStub,
        payment,
        previousStatus: "COLLECTED",
        newStatus: newStatus ?? "PENDING",
        userId: createdBy,
      },
      options
    );
  }
  if (
    entry.refType === "ADJUSTMENT" ||
    entry.refType === "PAYMENT_ADJUSTMENT" ||
    entry.refType === "ORDER_ADJUSTMENT" ||
    entry.refType === "BALANCE_ADJUSTMENT"
  ) {
    const isIncrease = (entry.debit || 0) > 0;
    const transitionKey =
      entry.metadata?.transitionKey || `${entry.refType}:${entry._id}`;
    if (entry.metadata?.adjustmentType === "REFUND" || entry.category === "Payment Adjustment") {
      return shadowAgriSalesReturn(
        {
          order: orderStub,
          amount: isIncrease ? entry.credit : -entry.debit,
          refundPayout: entry.metadata?.refundPayout,
          adjustmentKey: transitionKey,
          userId: createdBy,
        },
        options
      );
    }
    return shadowAgriOrderDelta(
      {
        order: orderStub,
        deltaAmount: isIncrease ? entry.debit : -entry.credit,
        isIncrease,
        transitionKey,
        userId: createdBy,
      },
      options
    );
  }
}

export function shadowAgriOrderCreated({ order, userId }, options = {}) {
  const amount = roundMoney(order.totalAmount);
  if (amount <= 0) return;
  return shadowEmit({
    idempotencyKey: `agri:order:${order._id}:create`,
    eventType: FINANCIAL_EVENT_TYPES.AGRI_ORDER_CREATED,
    sourceDomain: "AgriSalesOrder",
    sourceId: order._id,
    entryDate: order.orderDate || order.createdAt,
    createdBy: userId,
    payload: {
      amount,
      customerMobile: order.customerMobile,
      sourceLineRef: `order:${order._id}`,
    },
  }, options);
}

export function shadowAgriPayment({ order, payment, previousStatus, newStatus, userId }, options = {}) {
  const amount = roundMoney(payment?.paidAmount);
  if (amount <= 0) return;
  const isCollected = newStatus === "COLLECTED";
  const wasCollected = previousStatus === "COLLECTED";
  if (isCollected && !wasCollected) {
    return shadowEmit({
      idempotencyKey: `agri:payment:${payment._id}:collected`,
      eventType: FINANCIAL_EVENT_TYPES.AGRI_PAYMENT_COLLECTED,
      sourceDomain: "AgriSalesOrder",
      sourceId: order._id,
      entryDate: payment.paymentDate,
      createdBy: userId,
      payload: {
        amount,
        customerMobile: order.customerMobile,
        modeOfPayment: payment.modeOfPayment,
      },
    }, options);
  } else if (wasCollected && !isCollected) {
    return shadowEmit({
      idempotencyKey: `agri:payment:${payment._id}:rev:${newStatus}`,
      eventType: FINANCIAL_EVENT_TYPES.AGRI_PAYMENT_REVERSED,
      sourceDomain: "AgriSalesOrder",
      sourceId: order._id,
      createdBy: userId,
      payload: {
        amount,
        customerMobile: order.customerMobile,
        modeOfPayment: payment.modeOfPayment,
      },
    }, options);
  }
}

export function shadowAgriOrderDelta({ order, deltaAmount, isIncrease, transitionKey, userId }, options = {}) {
  const amount = roundMoney(Math.abs(deltaAmount));
  if (amount <= 0) return;
  return shadowEmit({
    idempotencyKey: `agri:order:${order._id}:delta:${transitionKey}`,
    eventType: FINANCIAL_EVENT_TYPES.AGRI_ORDER_DELTA,
    sourceDomain: "AgriSalesOrder",
    sourceId: order._id,
    createdBy: userId,
    payload: {
      amount,
      isIncrease,
      customerMobile: order.customerMobile,
    },
  }, options);
}

export function shadowAgriSalesReturn({ order, amount, refundPayout, adjustmentKey, userId }, options = {}) {
  const amt = roundMoney(Math.abs(amount));
  if (amt <= 0) return;
  return shadowEmit({
    idempotencyKey: `agri:return:${order._id}:${adjustmentKey}`,
    eventType: FINANCIAL_EVENT_TYPES.AGRI_SALES_RETURN,
    sourceDomain: "AgriSalesOrder",
    sourceId: order._id,
    createdBy: userId,
    payload: {
      amount: amt,
      customerMobile: order.customerMobile,
      refundPayout: Boolean(refundPayout),
    },
  }, options);
}

export function shadowDealerOrderBooking({ order, dealerId, amount, userId }, options = {}) {
  const amt = roundMoney(amount);
  if (amt <= 0) return;
  return shadowEmit({
    idempotencyKey: `dealer:booking:${order._id}`,
    eventType: FINANCIAL_EVENT_TYPES.DEALER_ORDER_BOOKING,
    sourceDomain: "Order",
    sourceId: order._id,
    createdBy: userId,
    payload: { amount: amt, dealerId: String(dealerId), sourceLineRef: `order:${order._id}` },
  }, options);
}

export function shadowDealerReceivablePayment({ order, payment, dealerId, userId }, options = {}) {
  const amt = roundMoney(payment?.paidAmount);
  if (amt <= 0) return;
  return shadowEmit({
    idempotencyKey: `dealer:recvpay:${payment._id}`,
    eventType: FINANCIAL_EVENT_TYPES.DEALER_RECEIVABLE_PAYMENT,
    sourceDomain: "Order",
    sourceId: order._id,
    createdBy: userId,
    payload: { amount: amt, dealerId: String(dealerId), sourceLineRef: `payment:${payment._id}` },
  }, options);
}

export function shadowDealerWalletMovement({ dealerId, amount, walletCredit, farmerPartyId, relatedOrderId, userId, idempotencySuffix }, options = {}) {
  const amt = roundMoney(Math.abs(amount));
  if (amt <= 0) return;
  return shadowEmit({
    idempotencyKey: `dealer:wallet:${dealerId}:${idempotencySuffix}`,
    eventType: FINANCIAL_EVENT_TYPES.DEALER_WALLET_MOVEMENT,
    sourceDomain: "DealerWallet",
    sourceId: relatedOrderId || dealerId,
    createdBy: userId,
    payload: {
      amount: amt,
      dealerId: String(dealerId),
      walletCredit: Boolean(walletCredit),
      farmerPartyId,
    },
  }, options);
}

export function shadowDealerCommissionSettlement({ dealerId, amount, settlementId, userId }, options = {}) {
  const amt = roundMoney(amount);
  if (amt <= 0) return;
  return shadowEmit({
    idempotencyKey: `dealer:commission:${settlementId}`,
    eventType: FINANCIAL_EVENT_TYPES.DEALER_COMMISSION_SETTLEMENT,
    sourceDomain: "DealerCommission",
    sourceId: settlementId,
    createdBy: userId,
    payload: { amount: amt, dealerId: String(dealerId) },
  }, options);
}

export function shadowBankPaymentVerified({ paymentId, orderMongoId, amount, userId }, options = {}) {
  const amt = roundMoney(amount);
  if (amt <= 0) return;
  return shadowEmit({
    idempotencyKey: `bank:verified:${paymentId}`,
    eventType: FINANCIAL_EVENT_TYPES.BANK_PAYMENT_VERIFIED,
    sourceDomain: "BankReconciliation",
    sourceId: paymentId,
    createdBy: userId,
    payload: { amount: amt, sourceLineRef: `payment:${paymentId}:order:${orderMongoId}` },
  }, options);
}
