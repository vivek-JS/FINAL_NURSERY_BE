import DealerLedgerEntry from "../models/dealerLedgerEntry.model.js";
import {
  getPlantOrderLineTotal,
  resolveFarmerIdentity,
} from "./farmerPlantOrderLedgerHelper.js";

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
    metadata,
    session,
  });
};

/**
 * Audit-only dealer ledger row when a dealerOrder is booked (no wallet balance change).
 */
export const ensureDealerOrderBookingAudit = async (order, { userId, session } = {}) => {
  if (!order?.dealerOrder || !order?.dealer) return null;

  const dealerId = order.dealer._id || order.dealer;
  const oid = order._id;

  const q = DealerLedgerEntry.findOne({ orderId: oid, refType: "ORDER_BOOKING" });
  if (session) q.session(session);
  const existing = await q.lean();
  if (existing) return existing;

  const { customerName } = await resolveFarmerIdentity(order);
  const lineTotal = getPlantOrderLineTotal(order);
  const plants =
    (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0);

  const entryPayload = {
    dealer: dealerId,
    refType: "ORDER_BOOKING",
    refId: oid,
    orderId: oid,
    debit: 0,
    credit: 0,
    reference: String(order.orderId ?? ""),
    description: customerName
      ? `Order ${order.orderId ?? ""} booked for ${customerName}`
      : `Order ${order.orderId ?? ""} booked`,
    createdBy: userId,
    entryDate: order.orderBookingDate || order.createdAt || new Date(),
    metadata: {
      auditOnly: true,
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
