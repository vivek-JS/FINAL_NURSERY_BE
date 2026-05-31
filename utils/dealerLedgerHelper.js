import DealerLedgerEntry from "../models/dealerLedgerEntry.model.js";
import {
  getPlantOrderLineTotal,
  isTerminalPlantOrderStatus,
  resolveFarmerIdentity,
  resolveFundingDealerId,
} from "./farmerPlantOrderLedgerHelper.js";

const ORDER_RECEIVABLE_REF_TYPES = ["ORDER_BOOKING", "ORDER_RECEIVABLE_PAYMENT"];

const REF_TYPE_SORT_ORDER = {
  ORDER_BOOKING: 0,
  ORDER_RECEIVABLE_PAYMENT: 1,
};

export function roundLedgerMoney(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/** Date-only paymentDate (midnight UTC) sorts before same-day bookings — use collection time instead. */
export function resolveReceivablePaymentEntryDate(payment) {
  if (payment?.paymentDate) {
    const d = new Date(payment.paymentDate);
    if (!Number.isNaN(d.getTime())) {
      const isUtcMidnight =
        d.getUTCHours() === 0 &&
        d.getUTCMinutes() === 0 &&
        d.getUTCSeconds() === 0 &&
        d.getUTCMilliseconds() === 0;
      if (isUtcMidnight) {
        if (payment.updatedAt) return new Date(payment.updatedAt);
        if (payment.createdAt) return new Date(payment.createdAt);
      }
      return d;
    }
  }
  if (payment?.updatedAt) return new Date(payment.updatedAt);
  return new Date();
}

/**
 * Chronological order for running outstanding (matches balanceBefore/After write order).
 * Uses createdAt — not entryDate alone — so date-only paymentDate cannot sort before bookings.
 */
export function sortReceivableLedgerEntriesChronologically(entries) {
  return [...entries].sort((a, b) => {
    const ca = new Date(a.createdAt || a.entryDate).getTime();
    const cb = new Date(b.createdAt || b.entryDate).getTime();
    if (ca !== cb) return ca - cb;
    const oa = REF_TYPE_SORT_ORDER[a.refType] ?? 9;
    const ob = REF_TYPE_SORT_ORDER[b.refType] ?? 9;
    if (oa !== ob) return oa - ob;
    const ta = new Date(a.entryDate).getTime();
    const tb = new Date(b.entryDate).getTime();
    if (ta !== tb) return ta - tb;
    return String(a._id).localeCompare(String(b._id));
  });
}

/**
 * Running order-value outstanding for dealer (ledger only — not wallet cash).
 * Sum of ORDER_BOOKING debits minus payment credits and order-cancel REVERSAL credits.
 */
export async function getLastDealerOrderOutstanding(dealerId, session) {
  const match = {
    dealer: dealerId,
    $or: [
      { refType: { $in: ORDER_RECEIVABLE_REF_TYPES } },
      {
        refType: { $in: ["REVERSAL", "ADJUSTMENT"] },
        "metadata.tracksOrderOutstanding": true,
      },
    ],
  };

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: null,
        debit: { $sum: { $ifNull: ["$debit", 0] } },
        credit: { $sum: { $ifNull: ["$credit", 0] } },
      },
    },
  ];

  let agg = DealerLedgerEntry.aggregate(pipeline);
  if (session) agg = agg.session(session);
  const row = (await agg)[0];
  if (!row) return 0;

  return roundLedgerMoney(Math.max(0, Number(row.debit) - Number(row.credit)));
}

/** Same formula as getLastDealerOrderOutstanding for API summary objects. */
export function computeOrderOutstandingFromTotals(totalDebit, totalCredit) {
  return roundLedgerMoney(
    Math.max(0, (Number(totalDebit) || 0) - (Number(totalCredit) || 0))
  );
}

/**
 * Maps addPayment type to DealerLedgerEntry refType
 */
const typeToRefType = {
  ORDER_PAYMENT: "ORDER_PAYMENT",
  PAYMENT_STATUS_UPDATE: "PAYMENT_STATUS_UPDATE",
  ADJUSTMENT: "ADJUSTMENT",
  MANUAL_ADJUSTMENT: "ADJUSTMENT",
  COMMISSION_SETTLEMENT: "COMMISSION_SETTLEMENT",
};

/**
 * Create an immutable dealer ledger entry.
 * @param {Object} params
 * @param {ObjectId} params.dealer - Dealer user ID
 * @param {string} params.refType - ORDER_PAYMENT | PAYMENT_STATUS_UPDATE | ADJUSTMENT | REVERSAL | MANUAL_CREDIT | MANUAL_DEBIT
 * @param {ObjectId} [params.refId] - Generic reference ID
 * @param {ObjectId} [params.orderId] - Related order ID
 * @param {ObjectId} [params.paymentId] - Related payment ID
 * @param {number} [params.debit] - Debit amount (mutually exclusive with credit)
 * @param {number} [params.credit] - Credit amount (mutually exclusive with debit)
 * @param {number} [params.balanceBefore] - Balance before this entry
 * @param {number} [params.balanceAfter] - Balance after this entry
 * @param {string} [params.reference] - Reference string
 * @param {string} [params.description] - Description
 * @param {ObjectId} [params.createdBy] - User who created the entry
 * @param {Object} [params.metadata] - Additional metadata (ipAddress, userAgent, notes)
 * @param {Date} [params.entryDate] - Entry date (default: now)
 * @param {ObjectId} [params.reversalOf] - ID of entry being reversed
 * @param {ClientSession} [params.session] - MongoDB session for transactional consistency
 * @returns {Promise<DealerLedgerEntry|null>}
 */
export const createDealerLedgerEntry = async ({
  dealer,
  refType,
  refId,
  orderId,
  paymentId,
  debit = 0,
  credit = 0,
  balanceBefore,
  balanceAfter,
  reference,
  description,
  createdBy,
  metadata = {},
  entryDate,
  reversalOf,
  session,
}) => {
  if (!dealer) {
    return null;
  }

  const normalizedDebit = Math.abs(Number(debit || 0));
  const normalizedCredit = Math.abs(Number(credit || 0));

  if (normalizedDebit === 0 && normalizedCredit === 0) {
    return null;
  }

  const entryPayload = {
    dealer,
    refType,
    refId,
    orderId,
    paymentId,
    debit: normalizedDebit,
    credit: normalizedCredit,
    balanceBefore,
    balanceAfter,
    reference,
    description,
    createdBy,
    metadata,
    entryDate: entryDate ? new Date(entryDate) : new Date(),
    reversalOf,
  };

  if (session) {
    const created = await DealerLedgerEntry.create([entryPayload], { session });
    return created[0];
  }

  return DealerLedgerEntry.create(entryPayload);
};

/**
 * Map addPayment params to createDealerLedgerEntry params.
 * @param {number} amount - Positive = credit, negative = debit
 * @param {string} type - ORDER_PAYMENT | PAYMENT_STATUS_UPDATE | ADJUSTMENT | MANUAL_ADJUSTMENT
 */
export const addPaymentToLedgerEntry = async ({
  dealerId,
  amount,
  description,
  performedBy,
  type,
  relatedOrder,
  balanceBefore,
  balanceAfter,
  metadata = {},
  session,
}) => {
  const refType = typeToRefType[type] || "ADJUSTMENT";
  const isCredit = amount >= 0;

  return createDealerLedgerEntry({
    dealer: dealerId,
    refType,
    orderId: relatedOrder,
    debit: isCredit ? 0 : Math.abs(amount),
    credit: isCredit ? Math.abs(amount) : 0,
    balanceBefore,
    balanceAfter,
    description,
    createdBy: performedBy,
    metadata: { ...metadata, tracksWalletCash: true },
    session,
  });
};

/**
 * Dealer receivable audit (ORDER_BOOKING) for any order funded by a dealer:
 * bulk dealerOrder, farmer order with order.dealer, or salesPerson with jobTitle DEALER.
 */
export const ensureDealerOrderBookingAudit = async (order, { userId, session } = {}) => {
  const dealerId = await resolveFundingDealerId(order);
  if (!dealerId) return null;

  const oid = order._id;

  const q = DealerLedgerEntry.findOne({ orderId: oid, refType: "ORDER_BOOKING" });
  if (session) q.session(session);
  const existing = await q.lean();
  if (existing) return existing;

  const { customerName } = await resolveFarmerIdentity(order);
  const lineTotal = roundLedgerMoney(getPlantOrderLineTotal(order));
  if (!(lineTotal > 0)) return null;

  const plants =
    (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0);
  const outstandingBefore = await getLastDealerOrderOutstanding(dealerId, session);
  const outstandingAfter = roundLedgerMoney(outstandingBefore + lineTotal);

  const entryPayload = {
    dealer: dealerId,
    refType: "ORDER_BOOKING",
    refId: oid,
    orderId: oid,
    debit: lineTotal,
    credit: 0,
    balanceBefore: outstandingBefore,
    balanceAfter: outstandingAfter,
    reference: String(order.orderId ?? ""),
    description: customerName
      ? `Order ${order.orderId ?? ""} booked for ${customerName} — outstanding`
      : `Order ${order.orderId ?? ""} booked — outstanding`,
    createdBy: userId,
    entryDate: order.orderBookingDate || order.createdAt || new Date(),
    metadata: {
      tracksOrderOutstanding: true,
      orderNumericId: order.orderId,
      lineTotal,
      plants,
      customerName: customerName || undefined,
    },
  };

  let createdEntry;
  if (session) {
    const created = await DealerLedgerEntry.create([entryPayload], { session });
    createdEntry = created[0];
  } else {
    createdEntry = await DealerLedgerEntry.create(entryPayload);
  }
  if (createdEntry) {
    try {
      const fs = await import("../modules/finance/integration/financeShadow.js");
      fs.shadowDealerOrderBooking({
        order,
        dealerId,
        amount: lineTotal,
        userId,
      });
    } catch (shadowErr) {
      console.error("[Finance] shadow dealer booking:", shadowErr?.message || shadowErr);
    }
  }
  return createdEntry;
};

/**
 * Credit dealer order outstanding when payment is collected (ledger only — wallet cash is separate).
 */
export async function findDealerOrderReceivablePaymentEntry(orderId, paymentId, session) {
  const q = DealerLedgerEntry.findOne({
    orderId,
    paymentId,
    refType: "ORDER_RECEIVABLE_PAYMENT",
  });
  if (session) q.session(session);
  return q.lean();
}

/**
 * Dealer receivable mirror for paymentStatus changes on dealer-funded orders.
 * COLLECTED → REJECTED/PENDING writes REVERSAL (debit); REJECTED → COLLECTED writes credit.
 */
export async function syncDealerLedgerForPaymentStatusTransition(
  order,
  payment,
  previousStatus,
  newStatus,
  { userId, session, descriptionOverride, metadataExtra } = {}
) {
  const dealerId = await resolveFundingDealerId(order);
  if (!dealerId || !payment?._id) return { action: "NONE" };

  const amount = roundLedgerMoney(Math.abs(Number(payment.paidAmount || 0)));
  if (!(amount > 0)) return { action: "NONE" };

  if (
    payment.transferredFromOrderId &&
    newStatus === "COLLECTED" &&
    !metadataExtra?.allowTransferIn
  ) {
    return { action: "SKIP_TRANSFER_IN" };
  }

  const prev = previousStatus;
  const next = newStatus;
  if (!prev || !next || prev === next) return { action: "NONE" };

  const oid = order._id;
  const pid = payment._id;
  const orderRef = String(order.orderId ?? "");

  if (next === "COLLECTED" && prev !== "COLLECTED") {
    const allowTransferIn = Boolean(metadataExtra?.allowTransferIn);
    const { allowTransferIn: _drop, ...metaForEntry } = metadataExtra || {};
    const row = await ensureDealerOrderReceivablePaymentCredit(order, payment, {
      userId,
      session,
      allowTransferIn,
      metadataExtra: metaForEntry,
    });
    return { action: row ? "CREDIT" : "NONE", entry: row };
  }

  if (
    prev === "COLLECTED" &&
    ["REJECTED", "PENDING", "BANK_VERIFIED"].includes(next)
  ) {
    const existing = await findDealerOrderReceivablePaymentEntry(oid, pid, session);
    if (!existing) return { action: "NONE" };

    const eventAt =
      payment?.updatedAt instanceof Date
        ? payment.updatedAt.getTime()
        : Date.now();
    const transitionKey = `recvpay_${pid}_${prev}_${next}_${eventAt}`;

    if (await dealerLedgerTransitionExists(oid, transitionKey, session)) {
      return { action: "DUPLICATE" };
    }

    const outstandingBefore = await getLastDealerOrderOutstanding(dealerId, session);
    const outstandingAfter = roundLedgerMoney(outstandingBefore + amount);

    const row = await createDealerLedgerEntry({
      dealer: dealerId,
      refType: "REVERSAL",
      refId: pid,
      orderId: oid,
      paymentId: pid,
      debit: amount,
      credit: 0,
      balanceBefore: outstandingBefore,
      balanceAfter: outstandingAfter,
      reference: orderRef,
      description:
        descriptionOverride != null && String(descriptionOverride).trim()
          ? String(descriptionOverride).trim()
          : `Payment no longer collected (${prev} → ${next}) — order ${orderRef}`,
      createdBy: userId,
      entryDate: resolveReceivablePaymentEntryDate(payment),
      reversalOf: existing._id,
      metadata: {
        tracksOrderOutstanding: true,
        transitionKey,
        previousStatus: prev,
        newStatus: next,
        reversedReceivablePaymentId: String(existing._id),
        ...(metadataExtra && typeof metadataExtra === "object" ? metadataExtra : {}),
      },
      session,
    });

    if (row) {
      try {
        const fs = await import("../modules/finance/integration/financeShadow.js");
        fs.shadowDealerReceivablePaymentReversal({
          order,
          payment,
          dealerId,
          userId,
          newStatus: next,
        });
      } catch (shadowErr) {
        console.error(
          "[Finance] shadow dealer receivable reversal:",
          shadowErr?.message || shadowErr
        );
      }
    }
    return { action: "REVERSAL", entry: row };
  }

  return { action: "NONE" };
}

/**
 * Paired dealer receivable rows for direct order payment transfer (net-zero on dealer outstanding).
 */
export async function syncDealerLedgerForDirectOrderPaymentTransfer(
  { sourceOrder, sourcePayment, targetOrder, targetPayment, transferId, userId },
  { session } = {}
) {
  const sourceDealer = await resolveFundingDealerId(sourceOrder);
  const targetDealer = await resolveFundingDealerId(targetOrder);
  if (!sourceDealer && !targetDealer) {
    return { source: null, target: null };
  }

  const xferMeta = {
    kind: "order_payment_transfer",
    transferId: transferId ? String(transferId) : undefined,
  };

  let sourceResult = null;
  let targetResult = null;

  if (sourceDealer) {
    sourceResult = await syncDealerLedgerForPaymentStatusTransition(
      sourceOrder,
      sourcePayment,
      "COLLECTED",
      "REJECTED",
      {
        userId,
        session,
        descriptionOverride: `Order payment transfer out — order ${sourceOrder.orderId ?? ""}`,
        metadataExtra: { ...xferMeta, direction: "out" },
      }
    );
  }

  if (targetDealer) {
    targetResult = await syncDealerLedgerForPaymentStatusTransition(
      targetOrder,
      targetPayment,
      "PENDING",
      "COLLECTED",
      {
        userId,
        session,
        descriptionOverride: `Order payment transfer in — order ${targetOrder.orderId ?? ""}`,
        metadataExtra: {
          ...xferMeta,
          direction: "in",
          allowTransferIn: true,
        },
      }
    );
  }

  return { source: sourceResult, target: targetResult };
}

/**
 * Undo paired dealer receivable rows when a transferred-in payment is rejected.
 */
export async function syncDealerLedgerForDirectOrderPaymentTransferUndo(
  { sourceOrder, sourcePayment, targetOrder, targetPayment, userId },
  { session } = {}
) {
  const undoMeta = { kind: "order_payment_transfer_undo" };
  let sourceResult = null;
  let targetResult = null;

  if (await resolveFundingDealerId(sourceOrder)) {
    sourceResult = await syncDealerLedgerForPaymentStatusTransition(
      sourceOrder,
      sourcePayment,
      "REJECTED",
      "COLLECTED",
      {
        userId,
        session,
        descriptionOverride: `Transfer undo — restore payment on order ${sourceOrder.orderId ?? ""}`,
        metadataExtra: { ...undoMeta, direction: "restore_source" },
      }
    );
  }

  if (await resolveFundingDealerId(targetOrder)) {
    targetResult = await syncDealerLedgerForPaymentStatusTransition(
      targetOrder,
      targetPayment,
      "COLLECTED",
      "REJECTED",
      {
        userId,
        session,
        descriptionOverride: `Transfer undo — reject transferred payment on order ${targetOrder.orderId ?? ""}`,
        metadataExtra: { ...undoMeta, direction: "reject_target" },
      }
    );
  }

  return { source: sourceResult, target: targetResult };
}

export const ensureDealerOrderReceivablePaymentCredit = async (
  order,
  payment,
  { userId, session, allowTransferIn = false, metadataExtra } = {}
) => {
  if (!payment?._id) return null;
  if (payment.transferredFromOrderId && !allowTransferIn) return null;

  const dealerId = await resolveFundingDealerId(order);
  if (!dealerId) return null;

  const amount = roundLedgerMoney(Math.abs(Number(payment.paidAmount || 0)));
  if (!(amount > 0)) return null;
  if (payment.paymentStatus !== "COLLECTED") return null;
  const oid = order._id;
  const pid = payment._id;

  const q = DealerLedgerEntry.findOne({
    orderId: oid,
    paymentId: pid,
    refType: "ORDER_RECEIVABLE_PAYMENT",
  });
  if (session) q.session(session);
  if (await q.lean()) return null;

  const outstandingBefore = await getLastDealerOrderOutstanding(dealerId, session);
  const outstandingAfter = roundLedgerMoney(Math.max(0, outstandingBefore - amount));

  const entryPayload = {
    dealer: dealerId,
    refType: "ORDER_RECEIVABLE_PAYMENT",
    refId: pid,
    orderId: oid,
    paymentId: pid,
    debit: 0,
    credit: amount,
    balanceBefore: outstandingBefore,
    balanceAfter: outstandingAfter,
    reference: String(order.orderId ?? ""),
    description: `Payment collected — order ${order.orderId ?? ""} (outstanding reduced)`,
    createdBy: userId,
    entryDate: resolveReceivablePaymentEntryDate(payment),
    metadata: {
      tracksOrderOutstanding: true,
      modeOfPayment: payment.modeOfPayment,
      isWalletPayment: Boolean(payment.isWalletPayment),
      ...(metadataExtra && typeof metadataExtra === "object" ? metadataExtra : {}),
    },
  };

  let createdEntry;
  if (session) {
    const created = await DealerLedgerEntry.create([entryPayload], { session });
    createdEntry = created[0];
  } else {
    createdEntry = await DealerLedgerEntry.create(entryPayload);
  }
  if (createdEntry) {
    try {
      const fs = await import("../modules/finance/integration/financeShadow.js");
      fs.shadowDealerReceivablePayment({
        order,
        payment,
        dealerId,
        userId,
      });
    } catch (shadowErr) {
      console.error("[Finance] shadow dealer receivable:", shadowErr?.message || shadowErr);
    }
  }
  return createdEntry;
};

async function dealerLedgerTransitionExists(orderId, transitionKey, session) {
  const q = DealerLedgerEntry.findOne({
    orderId,
    "metadata.transitionKey": transitionKey,
  });
  if (session) q.session(session);
  return Boolean(await q.lean());
}

/**
 * Net ORDER_BOOKING debit minus cancel REVERSAL credits for one order (dealer receivable slice).
 */
export async function getDealerOrderBookingNet(orderId, dealerId, session) {
  const match = {
    orderId,
    dealer: dealerId,
    $or: [
      { refType: "ORDER_BOOKING" },
      {
        refType: { $in: ["REVERSAL", "ADJUSTMENT"] },
        "metadata.tracksOrderOutstanding": true,
      },
    ],
  };
  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: null,
        debit: { $sum: { $ifNull: ["$debit", 0] } },
        credit: { $sum: { $ifNull: ["$credit", 0] } },
      },
    },
  ];
  let agg = DealerLedgerEntry.aggregate(pipeline);
  if (session) agg = agg.session(session);
  const row = (await agg)[0];
  if (!row) return 0;
  return roundLedgerMoney(Math.max(0, Number(row.debit) - Number(row.credit)));
}

/**
 * On cancel/reject/reopen, write immutable dealer receivable reversal or restore booking.
 */
export async function syncDealerLedgerOrderStatusTransition(
  existingDoc,
  updatedDoc,
  { userId, session } = {}
) {
  const prevStatus = existingDoc?.orderStatus;
  const nextStatus = updatedDoc?.orderStatus;
  if (!prevStatus || !nextStatus || prevStatus === nextStatus) return;

  const dealerId = await resolveFundingDealerId(updatedDoc);
  if (!dealerId) return;

  const oid = updatedDoc._id;
  const transitionAt =
    updatedDoc?.updatedAt instanceof Date
      ? updatedDoc.updatedAt.getTime()
      : updatedDoc?.updatedAt
        ? new Date(updatedDoc.updatedAt).getTime()
        : Date.now();
  const orderVersion =
    typeof updatedDoc?.__v === "number" || typeof updatedDoc?.__v === "string"
      ? String(updatedDoc.__v)
      : "0";
  const transitionKey = `DEALER_ORDER_STATUS_${oid}_${prevStatus}_${nextStatus}_${transitionAt}_${orderVersion}`;

  if (await dealerLedgerTransitionExists(oid, transitionKey, session)) return;

  const entryDate = Number.isFinite(transitionAt) ? new Date(transitionAt) : new Date();
  const { customerName } = await resolveFarmerIdentity(updatedDoc);
  const orderRef = String(updatedDoc.orderId ?? "");

  const wasTerminal = isTerminalPlantOrderStatus(prevStatus);
  const isTerminal = isTerminalPlantOrderStatus(nextStatus);

  if (isTerminal && !wasTerminal) {
    const bookingQ = DealerLedgerEntry.findOne({ orderId: oid, refType: "ORDER_BOOKING" });
    if (session) bookingQ.session(session);
    const booking = await bookingQ.lean();

    let reverseAmount = await getDealerOrderBookingNet(oid, dealerId, session);
    if (!(reverseAmount > 0) && booking?.debit > 0) {
      reverseAmount = roundLedgerMoney(booking.debit);
    }
    if (!(reverseAmount > 0)) {
      const lineTotal = roundLedgerMoney(getPlantOrderLineTotal(updatedDoc));
      if (lineTotal > 0) {
        const ensured =
          booking ||
          (await ensureDealerOrderBookingAudit(updatedDoc, { userId, session }));
        if (ensured) {
          reverseAmount = roundLedgerMoney(ensured.debit || lineTotal);
        }
      }
    }
    if (!(reverseAmount > 0)) return;

    const isCancel = nextStatus === "CANCELLED" || nextStatus === "TEMPORARY_CANCELLED";
    const category = isCancel ? "Order Cancel" : "Order Reject";
    const outstandingBefore = await getLastDealerOrderOutstanding(dealerId, session);
    const outstandingAfter = roundLedgerMoney(
      Math.max(0, outstandingBefore - reverseAmount)
    );

    const row = await createDealerLedgerEntry({
      dealer: dealerId,
      refType: "REVERSAL",
      refId: oid,
      orderId: oid,
      debit: 0,
      credit: reverseAmount,
      balanceBefore: outstandingBefore,
      balanceAfter: outstandingAfter,
      reference: orderRef,
      description: customerName
        ? `Order ${orderRef} ${category.toLowerCase()} — reverse booking for ${customerName}`
        : `Order ${orderRef} ${category.toLowerCase()} — reverse booking`,
      createdBy: userId,
      entryDate,
      reversalOf: booking?._id,
      metadata: {
        transitionKey,
        category,
        tracksOrderOutstanding: true,
        previousStatus: prevStatus,
        newStatus: nextStatus,
      },
      session,
    });

    if (row) {
      try {
        const fs = await import("../modules/finance/integration/financeShadow.js");
        fs.shadowDealerOrderCancel({
          order: updatedDoc,
          dealerId,
          amount: reverseAmount,
          userId,
          transitionKey,
        });
      } catch (shadowErr) {
        console.error("[Finance] shadow dealer cancel:", shadowErr?.message || shadowErr);
      }
    }
    return;
  }

  if (wasTerminal && !isTerminal) {
    const lineTotal = roundLedgerMoney(getPlantOrderLineTotal(updatedDoc));
    const netBooking = await getDealerOrderBookingNet(oid, dealerId, session);
    const restoreAmount = roundLedgerMoney(Math.max(lineTotal, netBooking));
    if (!(restoreAmount > 0)) return;

    let booking = null;
    if (netBooking <= 0) {
      const outstandingBefore = await getLastDealerOrderOutstanding(dealerId, session);
      const outstandingAfter = roundLedgerMoney(outstandingBefore + restoreAmount);
      const hadBookingQ = DealerLedgerEntry.findOne({
        orderId: oid,
        refType: "ORDER_BOOKING",
      });
      if (session) hadBookingQ.session(session);
      const hadBooking = await hadBookingQ.lean();

      if (hadBooking) {
        booking = await createDealerLedgerEntry({
          dealer: dealerId,
          refType: "ADJUSTMENT",
          refId: oid,
          orderId: oid,
          debit: restoreAmount,
          credit: 0,
          balanceBefore: outstandingBefore,
          balanceAfter: outstandingAfter,
          reference: orderRef,
          description: customerName
            ? `Order ${orderRef} reopened — restore booking for ${customerName}`
            : `Order ${orderRef} reopened — restore booking`,
          createdBy: userId,
          entryDate,
          metadata: {
            transitionKey,
            category: "Order Reopen",
            tracksOrderOutstanding: true,
            previousStatus: prevStatus,
            newStatus: nextStatus,
          },
          session,
        });
      } else {
        booking = await ensureDealerOrderBookingAudit(updatedDoc, { userId, session });
      }
    } else {
      booking = await ensureDealerOrderBookingAudit(updatedDoc, { userId, session });
    }

    if (booking) {
      try {
        const fs = await import("../modules/finance/integration/financeShadow.js");
        fs.shadowDealerOrderReopen({
          order: updatedDoc,
          dealerId,
          amount: restoreAmount,
          userId,
          transitionKey,
        });
      } catch (shadowErr) {
        console.error("[Finance] shadow dealer reopen:", shadowErr?.message || shadowErr);
      }
    }
  }
}

/**
 * Idempotent: ensure ORDER_BOOKING + COLLECTED payment credits exist for one order.
 */
export async function syncDealerLedgerForOrder(order, { userId, session } = {}) {
  const dealerId = await resolveFundingDealerId(order);
  if (!dealerId) {
    return { bookingCreated: false, paymentsCreated: 0 };
  }

  const oid = order._id;
  const hadBookingQ = DealerLedgerEntry.findOne({
    orderId: oid,
    refType: "ORDER_BOOKING",
  });
  if (session) hadBookingQ.session(session);
  const hadBooking = await hadBookingQ.lean();

  const booking = await ensureDealerOrderBookingAudit(order, { userId, session });
  const bookingCreated = Boolean(booking && !hadBooking);

  let paymentsCreated = 0;
  for (const payment of order.payment || []) {
    if (payment.paymentStatus !== "COLLECTED") continue;
    const hadPaymentQ = DealerLedgerEntry.findOne({
      orderId: oid,
      paymentId: payment._id,
      refType: "ORDER_RECEIVABLE_PAYMENT",
    });
    if (session) hadPaymentQ.session(session);
    const hadPayment = await hadPaymentQ.lean();
    const row = await ensureDealerOrderReceivablePaymentCredit(order, payment, {
      userId,
      session,
    });
    if (row && !hadPayment) paymentsCreated += 1;
  }

  return { bookingCreated, paymentsCreated };
}

/**
 * Fix payment rows whose entryDate (date-only) sorts before the order booking on the same order.
 */
export async function normalizeReceivablePaymentEntryDates(dealerId) {
  const payments = await DealerLedgerEntry.find({
    dealer: dealerId,
    refType: "ORDER_RECEIVABLE_PAYMENT",
  }).lean();

  let fixed = 0;
  for (const payment of payments) {
    if (!payment.orderId) continue;
    const booking = await DealerLedgerEntry.findOne({
      dealer: dealerId,
      orderId: payment.orderId,
      refType: "ORDER_BOOKING",
    }).lean();
    if (!booking?.entryDate || !payment.entryDate) continue;

    const payTs = new Date(payment.entryDate).getTime();
    const bookTs = new Date(booking.entryDate).getTime();
    if (payTs >= bookTs) continue;

    const nextDate = payment.createdAt
      ? new Date(payment.createdAt)
      : booking.entryDate;
    await DealerLedgerEntry.updateOne(
      { _id: payment._id },
      { $set: { entryDate: nextDate } }
    );
    fixed += 1;
  }
  return fixed;
}

/**
 * Backfill missing dealer ledger rows for orders linked to this dealer.
 */
export async function repairDealerLedgerForDealer(dealerId, { userId, limit = 300 } = {}) {
  const mongoose = (await import("mongoose")).default;
  const Order = (await import("../models/order.model.js")).default;
  const dealerOid = new mongoose.Types.ObjectId(dealerId);

  const orders = await Order.find({
    $or: [{ dealer: dealerOid }, { salesPerson: dealerOid }],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  let scanned = 0;
  let bookingsCreated = 0;
  let paymentsCreated = 0;

  for (const order of orders) {
    const funding = await resolveFundingDealerId(order);
    if (!funding || String(funding) !== String(dealerId)) continue;
    scanned += 1;
    const result = await syncDealerLedgerForOrder(order, { userId });
    if (result.bookingCreated) bookingsCreated += 1;
    paymentsCreated += result.paymentsCreated || 0;

    if (isTerminalPlantOrderStatus(order.orderStatus)) {
      const net = await getDealerOrderBookingNet(order._id, dealerId);
      if (net > 0) {
        const hadCancelReversal = await DealerLedgerEntry.findOne({
          orderId: order._id,
          refType: "REVERSAL",
          "metadata.tracksOrderOutstanding": true,
          "metadata.category": { $in: ["Order Cancel", "Order Reject"] },
        }).lean();
        if (!hadCancelReversal) {
          await syncDealerLedgerOrderStatusTransition(
            { ...order, orderStatus: "ACCEPTED" },
            order,
            { userId }
          );
        }
      }
    }
  }

  const entryDatesFixed = await normalizeReceivablePaymentEntryDates(dealerId);

  return { scanned, bookingsCreated, paymentsCreated, entryDatesFixed };
};
