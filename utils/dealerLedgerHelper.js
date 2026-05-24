import DealerLedgerEntry from "../models/dealerLedgerEntry.model.js";
import {
  getPlantOrderLineTotal,
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

/** Running order-value outstanding for dealer (ledger only — not wallet cash). */
export async function getLastDealerOrderOutstanding(dealerId, session) {
  const q = DealerLedgerEntry.find({
    dealer: dealerId,
    refType: { $in: ORDER_RECEIVABLE_REF_TYPES },
  }).lean();
  if (session) q.session(session);
  const docs = await q;
  if (!docs.length) return 0;

  const sorted = sortReceivableLedgerEntriesChronologically(docs);

  let running = 0;
  for (const d of sorted) {
    if (d.balanceAfter != null && !Number.isNaN(Number(d.balanceAfter))) {
      running = roundLedgerMoney(d.balanceAfter);
    } else {
      running = roundLedgerMoney(
        running + (Number(d.debit) || 0) - (Number(d.credit) || 0)
      );
    }
  }
  return running;
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

  if (session) {
    const created = await DealerLedgerEntry.create([entryPayload], { session });
    return created[0];
  }
  return DealerLedgerEntry.create(entryPayload);
};

/**
 * Credit dealer order outstanding when payment is collected (ledger only — wallet cash is separate).
 */
export const ensureDealerOrderReceivablePaymentCredit = async (
  order,
  payment,
  { userId, session } = {}
) => {
  if (!payment?._id) return null;

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
    },
  };

  if (session) {
    const created = await DealerLedgerEntry.create([entryPayload], { session });
    return created[0];
  }
  return DealerLedgerEntry.create(entryPayload);
};

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
  }

  const entryDatesFixed = await normalizeReceivablePaymentEntryDates(dealerId);

  return { scanned, bookingsCreated, paymentsCreated, entryDatesFixed };
};
