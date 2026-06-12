import mongoose from "mongoose";
import Farmer from "../models/farmer.model.js";
import User from "../models/user.model.js";
import Order from "../models/order.model.js";
import FarmerPlantOrderLedgerEntry from "../models/farmerPlantOrderLedger.model.js";
import FarmerPlantOrderArchive from "../models/farmerPlantOrderArchive.model.js";
import FarmerOrderTransferRequest from "../models/farmerOrderTransferRequest.model.js";
import { isDealerScopedTransferPair } from "../utility/orderTransferEligibility.js";
import { applyPaymentTimingToPayment } from "./paymentTiming.js";

const TERMINAL_PLANT_ORDER_STATUSES = new Set([
  "CANCELLED",
  "REJECTED",
  "TEMPORARY_CANCELLED",
]);

export function isTerminalPlantOrderStatus(status) {
  return TERMINAL_PLANT_ORDER_STATUSES.has(String(status || "").toUpperCase());
}

const DEBUG_ENDPOINT = "http://127.0.0.1:7242/ingest/44347468-0193-498c-9d04-ef8c3f7959e9";
const DEBUG_SESSION_ID = "69bde0";
const DEBUG_RUN_ID = "due-before-after-investigation";

function debugLog(hypothesisId, location, message, data = {}) {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      runId: DEBUG_RUN_ID,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

/** Same calendar second: ORDER before PAYMENT for correct running balance (shared with controller). */
export const LEDGER_REF_SORT = { ORDER: 0, PAYMENT: 1, ADJUSTMENT: 2, REVERSAL: 3 };

export function sortLedgerEntriesCanonical(docs) {
  return [...docs].sort((a, b) => {
    const ta = new Date(a.entryDate).getTime();
    const tb = new Date(b.entryDate).getTime();
    if (ta !== tb) return ta - tb;
    const ra = LEDGER_REF_SORT[a.refType] ?? 99;
    const rb = LEDGER_REF_SORT[b.refType] ?? 99;
    if (ra !== rb) return ra - rb;
    const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (ca !== cb) return ca - cb;
    return String(a._id ?? "").localeCompare(String(b._id ?? ""));
  });
}

export function roundMoney(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/**
 * Recompute final outstanding after each doc in order (when stored fields missing).
 */
export function computeOutstandingAfterChain(sortedDocs) {
  let running = 0;
  for (const d of sortedDocs) {
    running += (Number(d.debit) || 0) - (Number(d.credit) || 0);
    running = roundMoney(running);
  }
  return running;
}

/**
 * Farmer-plant ledger transition policy for paymentStatus changes.
 * "Action" determines which immutable ledger row type (if any) should be written.
 *
 * Rules (from product):
 * - PENDING -> COLLECTED => CREDIT
 * - COLLECTED -> PENDING => REVERSAL (DEBIT)
 * - COLLECTED -> REJECTED => REVERSAL (DEBIT)
 * - REJECTED -> PENDING => NONE
 * - REJECTED -> COLLECTED => CREDIT
 *
 * We also keep the historical behavior for BANK_VERIFIED:
 * - leaving COLLECTED to BANK_VERIFIED creates REVERSAL
 */
export function getFarmerPlantPaymentTransitionAction(
  previousStatus,
  newStatus
) {
  if (!newStatus) return "INVALID";

  // Newly-inserted payment (no prior status): credit immediately only when it
  // lands as COLLECTED. PENDING/REJECTED/etc. defer the credit until collected.
  if (!previousStatus) {
    return newStatus === "COLLECTED" ? "CREDIT" : "NONE";
  }

  if (previousStatus === newStatus) return "NONE";

  // Any "to COLLECTED" means we should credit to farmer (if amount > 0).
  if (newStatus === "COLLECTED") return "CREDIT";

  // Leaving COLLECTED means we reverse what was previously credited.
  if (
    previousStatus === "COLLECTED" &&
    ["PENDING", "REJECTED", "BANK_VERIFIED"].includes(newStatus)
  ) {
    return "REVERSAL";
  }

  // Default: no ledger operation.
  return "NONE";
}

/**
 * Last line's closing balance for this customer mobile (all ledger rows for that phone).
 */
export async function getLastOutstandingAfterForCustomer(customerMobile, session) {
  if (!customerMobile || !String(customerMobile).trim()) return 0;
  const q = FarmerPlantOrderLedgerEntry.find({
    customerMobile: String(customerMobile).trim(),
  }).lean();
  if (session) q.session(session);
  const docs = await q;
  if (!docs.length) return 0;
  const sorted = sortLedgerEntriesCanonical(docs);
  const last = sorted[sorted.length - 1];
  if (last.outstandingAfter != null && !Number.isNaN(Number(last.outstandingAfter))) {
    debugLog("H2", "farmerPlantOrderLedgerHelper.js:getLastOutstandingAfterForCustomer", "Using stored last outstandingAfter", {
      docsCount: docs.length,
      lastRefType: last.refType,
      lastEntryDate: last.entryDate,
      lastCreatedAt: last.createdAt,
      lastOutstandingAfter: Number(last.outstandingAfter),
    });
    return roundMoney(last.outstandingAfter);
  }
  const computed = roundMoney(computeOutstandingAfterChain(sorted));
  debugLog("H2", "farmerPlantOrderLedgerHelper.js:getLastOutstandingAfterForCustomer", "Using computed outstandingAfter chain", {
    docsCount: docs.length,
    computedOutstandingAfter: computed,
  });
  return computed;
}

/** Customer identity for farmer-plant ledger (farmer ref or orderFor on dealer orders). */
export function hasFarmerPlantLedgerIdentity(order) {
  if (!order) return false;
  if (order.farmer?._id || order.farmer) return true;
  const of = order.orderFor;
  return Boolean(of && String(of.name || "").trim());
}

export const shouldLogFarmerPlantLedger = (order) => {
  if (!order) return false;
  if (order.dealerOrder) return hasFarmerPlantLedgerIdentity(order);
  return Boolean(order.farmer);
};

export const getPlantOrderLineTotal = (order) => {
  const n = (order.numberOfPlants || 0) + (order.additionalPlants || 0);
  return Math.round((order.rate || 0) * n * 100) / 100;
};

export const normalizeFarmerMobile = (mobile) => {
  if (mobile == null || mobile === "") return null;
  const s = String(mobile).replace(/\D/g, "");
  if (s.length >= 10) return s.slice(-10);
  return s.length ? s : null;
};

export async function resolveFarmerIdentity(order) {
  const farmerId = order.farmer?._id || order.farmer;
  if (farmerId) {
    let farmer =
      order.farmer && typeof order.farmer === "object" && order.farmer.name
        ? order.farmer
        : await Farmer.findById(farmerId).lean();
    if (!farmer) {
      return { customerMobile: null, customerName: "", farmerId };
    }
    const customerMobile =
      normalizeFarmerMobile(farmer.mobileNumber) ||
      normalizeFarmerMobile(farmer.alternateNumber) ||
      normalizeFarmerMobile(farmer.originalPhoneNumber) ||
      `FARMER-${String(farmer._id || farmerId)}`;
    const customerName = (farmer.name || "").trim();
    return { customerMobile, customerName, farmerId: farmer._id || farmerId };
  }

  const of = order?.orderFor;
  if (of && String(of.name || "").trim()) {
    const customerMobile =
      normalizeFarmerMobile(of.mobileNumber) ||
      (order._id ? `ORDERFOR-${String(order._id)}` : null);
    return {
      customerMobile,
      customerName: String(of.name).trim(),
      farmerId: null,
    };
  }

  return { customerMobile: null, customerName: "", farmerId: null };
}

export async function resolveFundingDealerId(order) {
  if (!order) return null;

  if (order.dealer) {
    return order.dealer._id || order.dealer;
  }

  if (order.salesPerson) {
    const spId = order.salesPerson._id || order.salesPerson;
    const sp =
      order.salesPerson && typeof order.salesPerson === "object" && order.salesPerson.jobTitle
        ? order.salesPerson
        : await User.findById(spId).select("jobTitle").lean();
    if (sp && sp.jobTitle === "DEALER") {
      return spId;
    }
  }

  return null;
}

export async function ledgerTransitionExists(orderId, transitionKey, session) {
  const q = FarmerPlantOrderLedgerEntry.findOne({
    orderId,
    "metadata.transitionKey": transitionKey,
  });
  if (session) q.session(session);
  const doc = await q.lean();
  return Boolean(doc);
}

/**
 * Stable transitionKey when callers omit metadata.transitionKey.
 * Avoids E11000 on { orderId, metadata.transitionKey } where null collides with legacy ORDER rows.
 */
export function buildDefaultLedgerTransitionKey({
  refType,
  orderId,
  refId,
  paymentId,
  metadata = {},
}) {
  if (metadata?.transitionKey) return String(metadata.transitionKey);
  if (!orderId) return null;
  const oid = String(orderId);
  if (refType === "ORDER") return `ORDER_DEBIT:${oid}`;
  const rid = refId ? String(refId) : paymentId ? String(paymentId) : null;
  if (!rid) return null;
  return `${refType}:${oid}:${rid}`;
}

/** Idempotent keys for transfer-request approve / undo ledger rows. */
export function transferRequestLedgerTransitionKey(transferRequestId, part) {
  return `xfer_req:${String(transferRequestId)}:${part}`;
}

/**
 * Net receivable still attributed to this order in the farmer-plant sub-ledger (debits − credits).
 */
export async function getFarmerOrderLedgerNetReceivable(orderId, session) {
  if (!orderId) return 0;
  const q = FarmerPlantOrderLedgerEntry.find({ orderId }).select("debit credit").lean();
  if (session) q.session(session);
  const docs = await q;
  let net = 0;
  for (const d of docs) {
    net += (Number(d.debit) || 0) - (Number(d.credit) || 0);
  }
  return roundMoney(Math.max(0, net));
}

export async function createFarmerPlantLedgerEntry({
  customerMobile,
  customerName,
  farmerId,
  refType,
  refId,
  orderId,
  paymentId,
  debit = 0,
  credit = 0,
  reference,
  category,
  description,
  entryDate,
  createdBy,
  metadata = {},
  session,
}) {
  if (!customerMobile) {
    return null;
  }

  const normalizedDebit = Math.abs(Number(debit || 0));
  const normalizedCredit = Math.abs(Number(credit || 0));

  if (normalizedDebit === 0 && normalizedCredit === 0) {
    return null;
  }

  const mobileKey = customerMobile.trim();
  const lastAfter = await getLastOutstandingAfterForCustomer(mobileKey, session);
  const outstandingBefore = roundMoney(lastAfter);
  const outstandingAfter = roundMoney(
    outstandingBefore + normalizedDebit - normalizedCredit
  );
  debugLog("H2", "farmerPlantOrderLedgerHelper.js:createFarmerPlantLedgerEntry", "Computed row-wise outstanding values", {
    refType,
    orderId: String(orderId || ""),
    paymentId: String(paymentId || ""),
    debit: normalizedDebit,
    credit: normalizedCredit,
    outstandingBefore,
    outstandingAfter,
    entryDate: entryDate ? new Date(entryDate).toISOString() : null,
  });

  const transitionKey = buildDefaultLedgerTransitionKey({
    refType,
    orderId,
    refId,
    paymentId,
    metadata,
  });
  const resolvedMetadata = {
    ...metadata,
    ...(transitionKey ? { transitionKey } : {}),
  };

  const entryPayload = {
    customerMobile: mobileKey,
    customerName: customerName?.trim() || "",
    farmer: farmerId || undefined,
    entryDate: entryDate ? new Date(entryDate) : new Date(),
    refType,
    refId,
    orderId,
    paymentId,
    debit: normalizedDebit,
    credit: normalizedCredit,
    outstandingBefore,
    outstandingAfter,
    reference,
    category,
    description,
    createdBy,
    metadata: resolvedMetadata,
  };

  if (session) {
    try {
      const created = await FarmerPlantOrderLedgerEntry.create(
        [entryPayload],
        { session }
      );
      return created[0];
    } catch (e) {
      // Duplicate inside a transaction aborts the whole txn — do not swallow.
      if (e.code === 11000) {
        const err = new Error(
          `Farmer ledger duplicate (${refType}): ${e.message || "transitionKey conflict"}`
        );
        err.statusCode = 409;
        err.cause = e;
        throw err;
      }
      throw e;
    }
  }

  try {
    return await FarmerPlantOrderLedgerEntry.create(entryPayload);
  } catch (e) {
    if (e.code === 11000) return null;
    throw e;
  }
}

/**
 * Ensure ORDER debit exists (idempotent by refType ORDER + refId order._id).
 */
export async function ensureFarmerPlantOrderDebit(order, { userId, session } = {}) {
  if (!shouldLogFarmerPlantLedger(order)) return null;
  const { customerMobile, customerName, farmerId } = await resolveFarmerIdentity(order);
  if (!customerMobile) return null;

  const oid = order._id;
  /** Any ORDER line for this order counts — do not require refId (legacy rows may differ). */
  const q = FarmerPlantOrderLedgerEntry.findOne({
    orderId: oid,
    refType: "ORDER",
  });
  if (session) q.session(session);
  const exists = await q.lean();
  if (exists) return exists;

  const lineTotal = getPlantOrderLineTotal(order);
  const fundingDealerId = await resolveFundingDealerId(order);
  let fundingMeta;
  if (fundingDealerId && mongoose.Types.ObjectId.isValid(String(fundingDealerId))) {
    fundingMeta = new mongoose.Types.ObjectId(String(fundingDealerId));
  }

  const created = await createFarmerPlantLedgerEntry({
    customerMobile,
    customerName,
    farmerId,
    refType: "ORDER",
    refId: oid,
    orderId: oid,
    debit: lineTotal,
    reference: String(order.orderId ?? ""),
    category: "Order",
    description: `Order ${order.orderId ?? ""} — plant booking`,
    // For Excel-imported orders, use createdAt so entries remain visible in current-period ledger views.
    // For normal flows, keep booking-date semantics.
    entryDate:
      order.is_excel
        ? (order.createdAt || order.orderBookingDate)
        : (order.orderBookingDate || order.createdAt),
    createdBy: userId,
    metadata: {
      transitionKey: buildDefaultLedgerTransitionKey({
        refType: "ORDER",
        orderId: oid,
        refId: oid,
      }),
      orderNumericId: order.orderId,
      dealerOrder: Boolean(order.dealerOrder),
      ...(fundingMeta ? { fundingDealerId: fundingMeta } : {}),
    },
    session,
  });
  if (created) {
    try {
      const fs = await import("../modules/finance/integration/financeShadow.js");
      fs.shadowFarmerOrderCreated({ order, customerMobile, userId });
    } catch (shadowErr) {
      console.error("[Finance] shadow farmer order:", shadowErr?.message || shadowErr);
    }
    return created;
  }
  const q2 = FarmerPlantOrderLedgerEntry.findOne({ orderId: oid, refType: "ORDER" });
  if (session) q2.session(session);
  return q2.lean();
}

/**
 * Record payment status transition for farmer ledger (COLLECTED = credit; leaving COLLECTED = REVERSAL debit).
 * Optional: descriptionOverride, metadataExtra (merged into row metadata).
 */
export async function recordFarmerPlantLedgerPaymentTransition(
  order,
  payment,
  previousStatus,
  newStatus,
  { userId, session, descriptionOverride, metadataExtra } = {}
) {
  if (!shouldLogFarmerPlantLedger(order)) return null;
  const action = getFarmerPlantPaymentTransitionAction(previousStatus, newStatus);
  debugLog("H1", "farmerPlantOrderLedgerHelper.js:recordFarmerPlantLedgerPaymentTransition", "Transition classified", {
    orderId: String(order?._id || ""),
    paymentId: String(payment?._id || ""),
    previousStatus: previousStatus || null,
    newStatus: newStatus || null,
    action,
    paidAmount: Number(payment?.paidAmount || 0),
    paymentDate: payment?.paymentDate || null,
  });
  if (action !== "CREDIT" && action !== "REVERSAL") {
    // NONE / INVALID => no immutable ledger row to write.
    return null;
  }
  const { customerMobile, customerName, farmerId } = await resolveFarmerIdentity(order);
  if (!customerMobile) return null;

  const oid = order._id;
  const pid = payment._id;
  const amount = Math.abs(Number(payment.paidAmount || 0));
  const fundingDealerId = await resolveFundingDealerId(order);
  if (!(amount > 0)) return null;

  /**
   * Transition de-dupe key must allow repeated flips (PENDING→COLLECTED→PENDING→COLLECTED).
   * Use payment.updatedAt (subdoc timestamps) as event id so each change creates a new ledger line,
   * while still preventing duplicates within the same save.
   */
  const eventAt =
    payment?.updatedAt instanceof Date
      ? payment.updatedAt.getTime()
      : payment?.updatedAt
        ? new Date(payment.updatedAt).getTime()
        : order?.updatedAt instanceof Date
          ? order.updatedAt.getTime()
          : Date.now();

  const orderVersion =
    typeof order?.__v === "number" || typeof order?.__v === "string"
      ? String(order.__v)
      : "0";

  const transitionKey = `${pid}_${previousStatus || "NEW"}_${newStatus}_${eventAt}_${orderVersion}`;
  if (await ledgerTransitionExists(oid, transitionKey, session)) {
    debugLog("H4", "farmerPlantOrderLedgerHelper.js:recordFarmerPlantLedgerPaymentTransition", "Skipped duplicate transitionKey", {
      orderId: String(oid || ""),
      paymentId: String(pid || ""),
      transitionKey,
      action,
    });
    return null;
  }

  const baseMeta = {
    transitionKey,
    previousStatus: previousStatus || null,
    newStatus,
    isWalletPayment: Boolean(payment.isWalletPayment),
    fundingDealerId:
      payment.isWalletPayment && fundingDealerId
        ? typeof fundingDealerId === "string"
          ? new mongoose.Types.ObjectId(fundingDealerId)
          : fundingDealerId
        : undefined,
    ...(metadataExtra && typeof metadataExtra === "object" ? metadataExtra : {}),
  };
  const transitionOccurredAt = Number.isFinite(eventAt)
    ? new Date(eventAt)
    : new Date();

  if (action === "CREDIT") {
    const defaultCreditDesc = payment.isWalletPayment
      ? `Payment collected (dealer wallet) — ${payment.modeOfPayment || "wallet"}`
      : `Payment collected — ${payment.modeOfPayment || "—"}`;
    const row = await createFarmerPlantLedgerEntry({
      customerMobile,
      customerName,
      farmerId,
      refType: "PAYMENT",
      refId: pid,
      orderId: oid,
      paymentId: pid,
      credit: amount,
      reference: String(order.orderId ?? ""),
      category: "Payment",
      description:
        descriptionOverride != null && String(descriptionOverride).trim()
          ? String(descriptionOverride).trim()
          : defaultCreditDesc,
      entryDate: transitionOccurredAt,
      createdBy: userId,
      metadata: baseMeta,
      session,
    });
    if (row) {
      try {
        const fs = await import("../modules/finance/integration/financeShadow.js");
        fs.shadowFarmerPayment({
          order,
          payment,
          customerMobile,
          previousStatus,
          newStatus,
          userId,
        });
      } catch (shadowErr) {
        console.error("[Finance] shadow farmer payment:", shadowErr?.message || shadowErr);
      }
    }
    return row;
  }

  // action === "REVERSAL"
  const defaultReversalDesc = `Payment no longer collected (${previousStatus} → ${newStatus})`;
  const reversalRow = await createFarmerPlantLedgerEntry({
    customerMobile,
    customerName,
    farmerId,
    refType: "REVERSAL",
    refId: pid,
    orderId: oid,
    paymentId: pid,
    debit: amount,
    reference: String(order.orderId ?? ""),
    category: "Reversal",
    description:
      descriptionOverride != null && String(descriptionOverride).trim()
        ? String(descriptionOverride).trim()
        : defaultReversalDesc,
    entryDate: transitionOccurredAt,
    createdBy: userId,
    metadata: baseMeta,
    session,
  });
  if (reversalRow) {
    try {
      const fs = await import("../modules/finance/integration/financeShadow.js");
      fs.shadowFarmerPayment({
        order,
        payment,
        customerMobile,
        previousStatus,
        newStatus,
        userId,
      });
    } catch (shadowErr) {
      console.error("[Finance] shadow farmer reversal:", shadowErr?.message || shadowErr);
    }
  }
  return reversalRow;
}

/**
 * After an order update (factory), sync ORDER debit and payment transitions vs previous document.
 */
export async function syncFarmerPlantLedgerForOrderUpdate(
  existingDoc,
  updatedDoc,
  userId,
  session,
  options = {}
) {
  const strict = options?.strict === true;
  const orderEditSource = options?.orderEditSource;
  const isDispatchComplete = orderEditSource === "dispatch_complete";

  // Dealer receivable ledger (GET /dealers/:id/ledger) — not gated on farmer identity.
  try {
    const { syncDealerLedgerForOrder, syncDealerLedgerOrderStatusTransition } =
      await import("./dealerLedgerHelper.js");
    await syncDealerLedgerForOrder(updatedDoc, { userId, session });
    await syncDealerLedgerOrderStatusTransition(existingDoc, updatedDoc, {
      userId,
      session,
    });
  } catch (e) {
    console.error("syncDealerLedgerForOrder failed:", e);
    if (strict) throw e;
  }

  if (!shouldLogFarmerPlantLedger(updatedDoc)) return;

  try {
    await ensureFarmerPlantOrderDebit(updatedDoc, { userId, session });
  } catch (e) {
    console.error("ensureFarmerPlantOrderDebit failed:", e);
    if (strict) throw e;
  }

  // Order total edit transition: write immutable delta adjustment rows for rate/quantity changes.
  // Skip when previous state is terminal to avoid double-counting with reopen logic.
  try {
    const oid = updatedDoc?._id;
    const prevStatus = existingDoc?.orderStatus;
    const nextStatus = updatedDoc?.orderStatus;
    const prevIsTerminal = isTerminalPlantOrderStatus(prevStatus);

    const previousLineTotal = roundMoney(getPlantOrderLineTotal(existingDoc || {}));
    const nextLineTotal = roundMoney(getPlantOrderLineTotal(updatedDoc || {}));
    const deltaAmount = roundMoney(nextLineTotal - previousLineTotal);
    const hasDelta = Math.abs(deltaAmount) > 0;
    const oldRate = roundMoney(Number(existingDoc?.rate || 0));
    const oldQuantity = Number(existingDoc?.numberOfPlants || 0) + Number(existingDoc?.additionalPlants || 0);
    const newRate = roundMoney(Number(updatedDoc?.rate || 0));
    const newQuantity = Number(updatedDoc?.numberOfPlants || 0) + Number(updatedDoc?.additionalPlants || 0);

    if (oid && hasDelta && !prevIsTerminal) {
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
      const transitionKey = `ORDER_EDIT_DELTA_${oid}_${previousLineTotal}_${nextLineTotal}_${transitionAt}_${orderVersion}`;

      if (!(await ledgerTransitionExists(oid, transitionKey, session))) {
        const { customerMobile, customerName, farmerId } =
          await resolveFarmerIdentity(updatedDoc);

        if (!customerMobile) {
          if (strict && shouldLogFarmerPlantLedger(updatedDoc)) {
            throw new Error(
              "Cannot record farmer plant ledger for order total change: farmer contact mobile is missing."
            );
          }
        } else {
          const entryDate = Number.isFinite(transitionAt)
            ? new Date(transitionAt)
            : new Date();
          const isIncrease = deltaAmount > 0;
          const verbPhrase = isDispatchComplete
            ? "dispatch complete — total"
            : "edited — total";
          const description = isIncrease
            ? `Order ${updatedDoc.orderId ?? ""} ${verbPhrase} ₹${previousLineTotal} -> ₹${nextLineTotal} (debit +₹${Math.abs(deltaAmount)})`
            : `Order ${updatedDoc.orderId ?? ""} ${verbPhrase} ₹${previousLineTotal} -> ₹${nextLineTotal} (credit -₹${Math.abs(deltaAmount)})`;

          await createFarmerPlantLedgerEntry({
            customerMobile,
            customerName,
            farmerId,
            refType: "ADJUSTMENT",
            refId: oid,
            orderId: oid,
            debit: isIncrease ? Math.abs(deltaAmount) : 0,
            credit: isIncrease ? 0 : Math.abs(deltaAmount),
            reference: String(updatedDoc.orderId ?? ""),
            category: isIncrease ? "Order Edit Increase" : "Order Edit Decrease",
            description,
            entryDate,
            createdBy: userId,
            metadata: {
              transitionKey,
              previousStatus: prevStatus,
              newStatus: nextStatus,
              oldRate,
              oldQuantity,
              oldTotal: previousLineTotal,
              newRate,
              newQuantity,
              newTotal: nextLineTotal,
              previousLineTotal,
              nextLineTotal,
              deltaAmount,
              ...(orderEditSource ? { source: orderEditSource } : {}),
            },
            session,
          });
          try {
            const fs = await import("../modules/finance/integration/financeShadow.js");
            fs.shadowFarmerOrderDelta({
              order: updatedDoc,
              customerMobile,
              deltaAmount,
              isIncrease,
              transitionKey,
              userId,
              entryDate,
            });
          } catch (shadowErr) {
            console.error("[Finance] shadow farmer delta:", shadowErr?.message || shadowErr);
          }
        }
      }
    }
  } catch (e) {
    console.error("Farmer plant ledger order edit delta failed:", e);
    if (strict) throw e;
  }

  // Order status transition: write an immutable adjustment on cancel/re-open.
  try {
    const prevStatus = existingDoc?.orderStatus;
    const nextStatus = updatedDoc?.orderStatus;
    const isChanged = prevStatus && nextStatus && prevStatus !== nextStatus;
    if (isChanged) {
      const oid = updatedDoc?._id;
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
      const transitionKey = `ORDER_STATUS_${oid}_${prevStatus}_${nextStatus}_${transitionAt}_${orderVersion}`;

      if (!(await ledgerTransitionExists(oid, transitionKey, session))) {
        const { customerMobile, customerName, farmerId } =
          await resolveFarmerIdentity(updatedDoc);

        if (customerMobile) {
          const lineTotal = getPlantOrderLineTotal(updatedDoc);
          const entryDate = Number.isFinite(transitionAt)
            ? new Date(transitionAt)
            : new Date();

          const wasTerminal = isTerminalPlantOrderStatus(prevStatus);
          const isTerminal = isTerminalPlantOrderStatus(nextStatus);

          // Terminal: cancel, temporary cancel, or reject — reverse net order receivable.
          if (isTerminal && !wasTerminal) {
            const netReceivable = await getFarmerOrderLedgerNetReceivable(oid, session);
            const reverseAmount = roundMoney(
              Math.max(lineTotal, netReceivable)
            );
            if (reverseAmount > 0) {
              const isCancel =
                nextStatus === "CANCELLED" || nextStatus === "TEMPORARY_CANCELLED";
              await createFarmerPlantLedgerEntry({
                customerMobile,
                customerName,
                farmerId,
                refType: "ADJUSTMENT",
                refId: oid,
                orderId: oid,
                credit: reverseAmount,
                reference: String(updatedDoc.orderId ?? ""),
                category: isCancel ? "Order Cancel" : "Order Reject",
                description: isCancel
                  ? `Order ${updatedDoc.orderId ?? ""} cancelled — reverse order debit`
                  : `Order ${updatedDoc.orderId ?? ""} rejected — reverse order debit`,
                entryDate,
                createdBy: userId,
                metadata: {
                  transitionKey,
                  previousStatus: prevStatus,
                  newStatus: nextStatus,
                },
                session,
              });
              try {
                const fs = await import("../modules/finance/integration/financeShadow.js");
                fs.shadowFarmerOrderCancel({
                  order: updatedDoc,
                  customerMobile,
                  amount: reverseAmount,
                  userId,
                  transitionKey,
                });
              } catch (shadowErr) {
                console.error("[Finance] shadow farmer cancel:", shadowErr?.message || shadowErr);
              }
            }
          } else if (wasTerminal && !isTerminal) {
            // Re-open from terminal status: restore order debit so receivable returns.
            const restoreAmount = roundMoney(
              Math.max(lineTotal, await getFarmerOrderLedgerNetReceivable(oid, session))
            );
            if (restoreAmount > 0) {
              const fromReject = prevStatus === "REJECTED";
              await createFarmerPlantLedgerEntry({
                customerMobile,
                customerName,
                farmerId,
                refType: "ADJUSTMENT",
                refId: oid,
                orderId: oid,
                debit: restoreAmount,
                reference: String(updatedDoc.orderId ?? ""),
                category: "Order Reopen",
                description: fromReject
                  ? `Order ${updatedDoc.orderId ?? ""} reopened from rejected — restore order debit`
                  : `Order ${updatedDoc.orderId ?? ""} reopened — restore order debit`,
                entryDate,
                createdBy: userId,
                metadata: {
                  transitionKey,
                  previousStatus: prevStatus,
                  newStatus: nextStatus,
                },
                session,
              });
              try {
                const fs = await import("../modules/finance/integration/financeShadow.js");
                fs.shadowFarmerOrderReopen({
                  order: updatedDoc,
                  customerMobile,
                  amount: restoreAmount,
                  userId,
                  transitionKey,
                });
              } catch (shadowErr) {
                console.error("[Finance] shadow farmer reopen:", shadowErr?.message || shadowErr);
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("Farmer plant ledger status transition failed:", e);
    if (strict) throw e;
  }

  const beforeMap = {};
  (existingDoc.payment || []).forEach((p) => {
    if (p._id) beforeMap[p._id.toString()] = p.paymentStatus;
  });

  for (const p of updatedDoc.payment || []) {
    if (!p._id) continue;
    const pid = p._id.toString();
    const prev = beforeMap[pid] !== undefined ? beforeMap[pid] : "NEW";
    const now = p.paymentStatus;
    if (prev === now) continue;
    try {
      await recordFarmerPlantLedgerPaymentTransition(
        updatedDoc,
        p,
        prev === "NEW" ? null : prev,
        now,
        { userId, session }
      );
    } catch (e) {
      console.error("Farmer plant ledger payment transition failed:", e);
      if (strict) throw e;
    }
  }

  if (orderEditSource === "dispatch_complete") {
    try {
      await recordFarmerPlantLedgerDispatchReturnCredit(
        existingDoc,
        updatedDoc,
        userId,
        session,
        { strict }
      );
    } catch (e) {
      console.error("Farmer plant ledger dispatch return credit failed:", e);
      if (strict) throw e;
    }
    try {
      await recordFarmerPlantLedgerDispatchDamagedCredit(
        existingDoc,
        updatedDoc,
        userId,
        session,
        { strict }
      );
    } catch (e) {
      console.error("Farmer plant ledger dispatch damaged credit failed:", e);
      if (strict) throw e;
    }
  }
}

/**
 * Credit farmer receivable for plants returned on dispatch (delta returnedPlants × rate).
 * Idempotent per (oldReturned, newReturned) transition.
 */
export async function recordFarmerPlantLedgerDispatchReturnCredit(
  existingDoc,
  updatedDoc,
  userId,
  session,
  options = {}
) {
  const strict = options.strict === true;
  if (!shouldLogFarmerPlantLedger(updatedDoc)) return;

  const oldR = Number(existingDoc?.returnedPlants) || 0;
  const newR = Number(updatedDoc?.returnedPlants) || 0;
  const delta = newR - oldR;
  if (delta <= 0) return;

  const rate = roundMoney(Number(updatedDoc?.rate || 0));
  const creditAmount = roundMoney(delta * rate);
  if (creditAmount <= 0) return;

  const oid = updatedDoc?._id;
  if (!oid) return;

  const transitionKey = `DISPATCH_RETURN_FARMER_${oid}_${oldR}_${newR}`;

  if (await ledgerTransitionExists(oid, transitionKey, session)) return;

  const { customerMobile, customerName, farmerId } =
    await resolveFarmerIdentity(updatedDoc);

  if (!customerMobile) {
    if (strict) {
      throw new Error(
        "Cannot record farmer plant ledger for dispatch return: farmer contact mobile is missing."
      );
    }
    return;
  }

  const transitionAt =
    updatedDoc?.updatedAt instanceof Date
      ? updatedDoc.updatedAt.getTime()
      : updatedDoc?.updatedAt
        ? new Date(updatedDoc.updatedAt).getTime()
        : Date.now();

  const entryDate = Number.isFinite(transitionAt)
    ? new Date(transitionAt)
    : new Date();

  await createFarmerPlantLedgerEntry({
    customerMobile,
    customerName,
    farmerId,
    refType: "ADJUSTMENT",
    refId: oid,
    orderId: oid,
    debit: 0,
    credit: creditAmount,
    reference: String(updatedDoc.orderId ?? ""),
    category: "Dispatch Return",
    description: `Order ${updatedDoc.orderId ?? ""} dispatch return — ${delta} plants × ₹${rate} (credit receivable)`,
    entryDate,
    createdBy: userId,
    metadata: {
      transitionKey,
      oldReturnedPlants: oldR,
      newReturnedPlants: newR,
      deltaReturnedPlants: delta,
      rate,
      source: "dispatch_complete",
    },
    session,
  });
  try {
    const fs = await import("../modules/finance/integration/financeShadow.js");
    fs.shadowFarmerDispatchReturn({
      order: updatedDoc,
      customerMobile,
      amount: creditAmount,
      transitionKey,
      userId,
    });
  } catch (shadowErr) {
    console.error("[Finance] shadow dispatch return:", shadowErr?.message || shadowErr);
  }
}

/**
 * Credit farmer receivable for plants marked damaged on dispatch (delta damagedPlants × rate).
 * Same monetary treatment as returns; idempotent per (oldDamaged, newDamaged).
 */
export async function recordFarmerPlantLedgerDispatchDamagedCredit(
  existingDoc,
  updatedDoc,
  userId,
  session,
  options = {}
) {
  const strict = options.strict === true;
  if (!shouldLogFarmerPlantLedger(updatedDoc)) return;

  const oldD = Number(existingDoc?.damagedPlants) || 0;
  const newD = Number(updatedDoc?.damagedPlants) || 0;
  const delta = newD - oldD;
  if (delta <= 0) return;

  const rate = roundMoney(Number(updatedDoc?.rate || 0));
  const creditAmount = roundMoney(delta * rate);
  if (creditAmount <= 0) return;

  const oid = updatedDoc?._id;
  if (!oid) return;

  const transitionKey = `DISPATCH_DAMAGED_FARMER_${oid}_${oldD}_${newD}`;

  if (await ledgerTransitionExists(oid, transitionKey, session)) return;

  const { customerMobile, customerName, farmerId } =
    await resolveFarmerIdentity(updatedDoc);

  if (!customerMobile) {
    if (strict) {
      throw new Error(
        "Cannot record farmer plant ledger for dispatch damaged: farmer contact mobile is missing."
      );
    }
    return;
  }

  const transitionAt =
    updatedDoc?.updatedAt instanceof Date
      ? updatedDoc.updatedAt.getTime()
      : updatedDoc?.updatedAt
        ? new Date(updatedDoc.updatedAt).getTime()
        : Date.now();

  const entryDate = Number.isFinite(transitionAt)
    ? new Date(transitionAt)
    : new Date();

  await createFarmerPlantLedgerEntry({
    customerMobile,
    customerName,
    farmerId,
    refType: "ADJUSTMENT",
    refId: oid,
    orderId: oid,
    debit: 0,
    credit: creditAmount,
    reference: String(updatedDoc.orderId ?? ""),
    category: "Dispatch Damaged",
    description: `Order ${updatedDoc.orderId ?? ""} dispatch damaged — ${delta} plants × ₹${rate} (credit receivable)`,
    entryDate,
    createdBy: userId,
    metadata: {
      transitionKey,
      oldDamagedPlants: oldD,
      newDamagedPlants: newD,
      deltaDamagedPlants: delta,
      rate,
      source: "dispatch_complete",
    },
    session,
  });
  try {
    const fs = await import("../modules/finance/integration/financeShadow.js");
    fs.shadowFarmerDispatchReturn({
      order: updatedDoc,
      customerMobile,
      amount: creditAmount,
      transitionKey: transitionKey.replace("RETURN", "DAMAGED"),
      userId,
    });
  } catch (shadowErr) {
    console.error("[Finance] shadow dispatch damaged:", shadowErr?.message || shadowErr);
  }
}

export async function archiveFarmerPlantOrderBeforeDelete(doc, deletedBy) {
  if (!doc || doc.dealerOrder) return null;
  if (!doc.farmer) return null;
  const exists = await FarmerPlantOrderArchive.findOne({
    originalOrderId: doc._id,
  }).lean();
  if (exists) return exists;
  const snapshot = doc.toObject ? doc.toObject() : { ...doc };
  return FarmerPlantOrderArchive.create({
    originalOrderId: doc._id,
    orderId: doc.orderId,
    snapshot,
    deletedBy: deletedBy || undefined,
  });
}

export async function computeOrderPaymentTotals(order) {
  const totalOrderedPlants =
    (order.numberOfPlants || 0) + (order.additionalPlants || 0);
  const freight = Math.max(0, Number(order.freightCharges) || 0);
  const orderTotal =
    Math.round(((order.rate || 0) * totalOrderedPlants + freight) * 100) / 100;
  const totalCollected = (order.payment || [])
    .filter((p) => p.paymentStatus === "COLLECTED")
    .reduce((sum, p) => sum + (Number(p.paidAmount) || 0), 0);
  const outstanding = Math.round((orderTotal - totalCollected) * 100) / 100;
  return {
    orderTotal,
    totalCollected,
    outstanding,
    isFullyPaid: outstanding <= 0,
  };
}

/** True when COLLECTED must not be set again on this transfer-request payment line. */
export function isBlockedTransferRequestReCollect(payment, transferRequest) {
  if (!payment?.transferRequestId || !transferRequest) return false;
  if (transferRequest.status === "REJECTED") return true;
  if (
    transferRequest.status === "APPROVED" &&
    payment.paymentStatus === "REJECTED"
  ) {
    return true;
  }
  return /Transfer request undone/i.test(String(payment.remark || ""));
}

/** Target payment row created by POST transfer-order-payment (not transfer-request flow). */
export function isDirectOrderPaymentTransfer(payment) {
  if (!payment) return false;
  if (payment.transferRequestId) return false;
  const fromOrder = payment.transferredFromOrderId;
  const fromPayment = payment.transferredFromPaymentId;
  return Boolean(fromOrder && fromPayment);
}

export function findPaymentInOrder(order, paymentId) {
  if (!order?.payment?.length) return null;
  if (paymentId == null || paymentId === "") return null;
  let p = order.payment.id(paymentId);
  if (p) return p;
  const s = String(paymentId).trim();
  if (mongoose.Types.ObjectId.isValid(s)) {
    const oid = new mongoose.Types.ObjectId(s);
    p = order.payment.id(oid);
    if (p) return p;
  }
  return order.payment.find((x) => x?._id && String(x._id) === s);
}

export function recomputeOrderPaymentCompletion(order) {
  const plants = (order.numberOfPlants || 0) + (order.additionalPlants || 0);
  const freight = Math.max(0, Number(order.freightCharges) || 0);
  const total = roundMoney((order.rate || 0) * plants + freight);
  const collected = roundMoney(
    (order.payment || []).reduce((sum, p) => {
      if (p?.paymentStatus === "COLLECTED") return sum + (Number(p.paidAmount) || 0);
      return sum;
    }, 0)
  );
  order.orderPaymentStatus = collected >= total ? "COMPLETED" : "PENDING";
  order.paymentCompleted = collected >= total;
}

/**
 * Legacy direct transfers wrote farmer-plant ledger rows with metadata.kind order_payment_transfer.
 */
export async function hasLegacyDirectTransferLedgerEntries(
  { sourceOrderId, sourcePaymentId, targetOrderId, targetPaymentId },
  { session } = {}
) {
  const oidSource =
    sourceOrderId instanceof mongoose.Types.ObjectId
      ? sourceOrderId
      : new mongoose.Types.ObjectId(String(sourceOrderId));
  const oidTarget =
    targetOrderId instanceof mongoose.Types.ObjectId
      ? targetOrderId
      : new mongoose.Types.ObjectId(String(targetOrderId));
  const pidSource =
    sourcePaymentId instanceof mongoose.Types.ObjectId
      ? sourcePaymentId
      : new mongoose.Types.ObjectId(String(sourcePaymentId));
  const pidTarget =
    targetPaymentId instanceof mongoose.Types.ObjectId
      ? targetPaymentId
      : new mongoose.Types.ObjectId(String(targetPaymentId));

  const q = FarmerPlantOrderLedgerEntry.findOne({
    "metadata.kind": "order_payment_transfer",
    $or: [
      { orderId: oidSource, paymentId: pidSource },
      { orderId: oidTarget, paymentId: pidTarget },
    ],
  });
  if (session) q.session(session);
  return Boolean(await q.lean());
}

/**
 * Undo a direct order payment transfer when the target (transferred-in) payment is rejected.
 * Restores source payment to COLLECTED; marks target REJECTED; reverses all ledgers.
 */
export async function undoDirectOrderPaymentTransfer({
  targetOrder,
  targetPayment,
  userId,
  remark,
}) {
  if (!isDirectOrderPaymentTransfer(targetPayment)) {
    const err = new Error("Payment is not from a direct order-to-order transfer");
    err.statusCode = 400;
    throw err;
  }

  const targetStatus = targetPayment.paymentStatus;
  if (!["COLLECTED", "PENDING"].includes(targetStatus)) {
    const err = new Error(
      `Cannot undo transfer: target payment status is ${targetStatus}`
    );
    err.statusCode = 409;
    throw err;
  }

  const sid = String(targetPayment.transferredFromOrderId);
  const spid = String(targetPayment.transferredFromPaymentId);
  const amount = roundMoney(Math.abs(Number(targetPayment.paidAmount || 0)));
  if (!(amount > 0)) {
    const err = new Error("Transfer payment amount must be greater than zero");
    err.statusCode = 400;
    throw err;
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const sourceOrder = await Order.findById(sid).session(session);
    const targetOrderDoc = await Order.findById(targetOrder._id).session(session);
    if (!sourceOrder || !targetOrderDoc) {
      const err = new Error("Source or target order not found");
      err.statusCode = 404;
      throw err;
    }

    const sourcePayment = findPaymentInOrder(sourceOrder, spid);
    const targetPay = findPaymentInOrder(
      targetOrderDoc,
      targetPayment._id || targetPayment
    );
    if (!sourcePayment || !targetPay) {
      const err = new Error("Source or target payment not found");
      err.statusCode = 404;
      throw err;
    }

    if (sourcePayment.paymentStatus !== "REJECTED") {
      const err = new Error(
        "Source payment is not in REJECTED state; transfer may already be undone"
      );
      err.statusCode = 409;
      throw err;
    }

    const sourceAmount = roundMoney(Math.abs(Number(sourcePayment.paidAmount || 0)));
    if (Math.abs(sourceAmount - amount) > 0.01) {
      const err = new Error("Transfer amounts on source and target do not match");
      err.statusCode = 409;
      throw err;
    }

    const targetNumericId = targetOrderDoc.orderId ?? "";
    const sourceNumericId = sourceOrder.orderId ?? "";
    const undoNoteTarget = `[Transfer undone — payment rejected${
      remark ? `: ${String(remark).trim()}` : ""
    }]`;
    const undoNoteSource = `[Transfer undone — restored from order #${targetNumericId}]`;

    const prevTargetStatus = targetPay.paymentStatus;
    targetPay.paymentStatus = "REJECTED";
    const prevTargetRemark = targetPay.remark ? String(targetPay.remark).trim() : "";
    targetPay.remark = prevTargetRemark
      ? `${prevTargetRemark}\n${undoNoteTarget}`
      : undoNoteTarget;
    applyPaymentTimingToPayment(targetPay, targetOrderDoc, { force: true });

    const prevSourceStatus = sourcePayment.paymentStatus;
    sourcePayment.paymentStatus = "COLLECTED";
    const prevSourceRemark = sourcePayment.remark ? String(sourcePayment.remark).trim() : "";
    sourcePayment.remark = prevSourceRemark
      ? `${prevSourceRemark}\n${undoNoteSource}`
      : undoNoteSource;
    applyPaymentTimingToPayment(sourcePayment, sourceOrder, { force: true });

    recomputeOrderPaymentCompletion(sourceOrder);
    recomputeOrderPaymentCompletion(targetOrderDoc);

    const performedBy = userId || null;
    if (!Array.isArray(sourceOrder.orderEditHistory)) sourceOrder.orderEditHistory = [];
    sourceOrder.orderEditHistory.push({
      field: "paymentTransferUndo",
      previousValue: { paymentStatus: prevSourceStatus, targetOrderNumber: targetNumericId },
      newValue: { paymentStatus: "COLLECTED", amount },
      changedBy: performedBy,
      notes: undoNoteSource,
    });
    if (!Array.isArray(targetOrderDoc.orderEditHistory)) {
      targetOrderDoc.orderEditHistory = [];
    }
    targetOrderDoc.orderEditHistory.push({
      field: "paymentTransferUndo",
      previousValue: {
        paymentStatus: prevTargetStatus,
        sourceOrderNumber: sourceNumericId,
      },
      newValue: { paymentStatus: "REJECTED", amount },
      changedBy: performedBy,
      notes: undoNoteTarget,
    });

    await sourceOrder.save({ session });
    await targetOrderDoc.save({ session });

    const transferId =
      targetPay.orderPaymentTransferId ||
      sourcePayment.orderPaymentTransferId ||
      null;

    const { syncDirectOrderPaymentTransferUndoLedgers } = await import(
      "../services/orderPaymentTransferLedger.service.js"
    );
    const ledgerUndo = await syncDirectOrderPaymentTransferUndoLedgers(
      {
        sourceOrder,
        sourcePayment,
        targetOrder: targetOrderDoc,
        targetPayment: targetPay,
        transferId,
        userId,
        prevTargetStatus,
      },
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    return {
      sourceOrder,
      targetOrder: targetOrderDoc,
      transferId: transferId ? String(transferId) : null,
      ledgerUndo,
      sourceLedgerUndoId: ledgerUndo?.farmer?.source?._id || null,
      targetLedgerUndoId: ledgerUndo?.farmer?.target?._id || null,
    };
  } catch (e) {
    try {
      await session.abortTransaction();
    } catch (_) {}
    try {
      session.endSession();
    } catch (_) {}
    throw e;
  }
}

/** Parse ₹ amount from approve remark: `[Transfer request #<id> approved: -₹1,000 moved ...]` */
export function parseTransferRequestDeductionFromRemark(remark, requestId) {
  const reqIdStr = String(requestId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\[Transfer request #${reqIdStr} approved: -₹([\\d,.]+) moved`,
    "i"
  );
  const m = String(remark || "").match(re);
  if (!m) return 0;
  return roundMoney(Number(String(m[1]).replace(/,/g, "")) || 0);
}

/**
 * Undo an APPROVED transfer request when the target COLLECTED payment is rejected.
 * Restores source order payment amounts; marks target REJECTED; reverses farmer ledger when posted.
 */
export async function undoApprovedTransferRequestPayment({
  targetOrder,
  targetPayment,
  userId,
  remark,
}) {
  const requestId = targetPayment?.transferRequestId;
  if (!requestId) {
    const err = new Error("Payment is not linked to a transfer request");
    err.statusCode = 400;
    throw err;
  }
  if (!["COLLECTED", "PENDING"].includes(targetPayment.paymentStatus)) {
    const err = new Error(
      `Cannot undo transfer request: target payment status is ${targetPayment.paymentStatus}`
    );
    err.statusCode = 409;
    throw err;
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const requestDoc = await FarmerOrderTransferRequest.findById(requestId).session(session);
    if (!requestDoc) {
      const err = new Error("Transfer request not found");
      err.statusCode = 404;
      throw err;
    }
    if (requestDoc.status !== "APPROVED") {
      const err = new Error(
        `Transfer request status is ${requestDoc.status}; only APPROVED requests can be undone via payment reject`
      );
      err.statusCode = 409;
      throw err;
    }

    const amount = roundMoney(Math.abs(Number(requestDoc.requestedAmount || 0)));
    if (!(amount > 0)) {
      const err = new Error("Transfer request amount must be greater than zero");
      err.statusCode = 400;
      throw err;
    }

    const sourceOrder = await Order.findById(requestDoc.fromOrderId).session(session);
    const targetOrderDoc = await Order.findById(targetOrder._id).session(session);
    if (!sourceOrder || !targetOrderDoc) {
      const err = new Error("Source or target order not found");
      err.statusCode = 404;
      throw err;
    }

    const targetPay = findPaymentInOrder(
      targetOrderDoc,
      targetPayment._id || targetPayment
    );
    if (!targetPay) {
      const err = new Error("Target payment not found");
      err.statusCode = 404;
      throw err;
    }

    let restoredTotal = 0;
    for (const p of sourceOrder.payment || []) {
      const deduct = parseTransferRequestDeductionFromRemark(p.remark, requestDoc._id);
      if (!(deduct > 0)) continue;
      p.paidAmount = roundMoney(Number(p.paidAmount || 0) + deduct);
      restoredTotal = roundMoney(restoredTotal + deduct);
      const undoNote = `[Transfer request #${requestDoc._id} undone: +₹${deduct.toLocaleString("en-IN")} restored]`;
      const prevRemark = p.remark ? String(p.remark).trim() : "";
      p.remark = prevRemark ? `${prevRemark}\n${undoNote}` : undoNote;
      applyPaymentTimingToPayment(p, sourceOrder, { force: true });
    }

    if (Math.abs(restoredTotal - amount) > 0.02) {
      const err = new Error(
        `Could not restore source payments (restored ₹${restoredTotal}, expected ₹${amount})`
      );
      err.statusCode = 409;
      throw err;
    }

    const sourceNumericId = sourceOrder.orderId ?? "";
    const targetNumericId = targetOrderDoc.orderId ?? "";
    const undoNoteTarget = `[Transfer request undone — payment rejected${
      remark ? `: ${String(remark).trim()}` : ""
    }]`;

    const prevTargetStatus = targetPay.paymentStatus;
    targetPay.paymentStatus = "REJECTED";
    const prevTargetRemark = targetPay.remark ? String(targetPay.remark).trim() : "";
    targetPay.remark = prevTargetRemark
      ? `${prevTargetRemark}\n${undoNoteTarget}`
      : undoNoteTarget;
    applyPaymentTimingToPayment(targetPay, targetOrderDoc, { force: true });

    recomputeOrderPaymentCompletion(sourceOrder);
    recomputeOrderPaymentCompletion(targetOrderDoc);

    const performedBy = userId || null;

    const { syncTransferRequestUndoLedgers } = await import(
      "../services/orderPaymentTransferRequestLedger.service.js"
    );
    const ledgerUndo = await syncTransferRequestUndoLedgers(
      {
        sourceOrder,
        targetOrder: targetOrderDoc,
        targetPayment: targetPay,
        transferRequestId: requestDoc._id,
        amount,
        restoredTotal,
        userId: performedBy,
        prevTargetStatus,
      },
      { session }
    );

    requestDoc.status = "REJECTED";
    requestDoc.approval = {
      ...(requestDoc.approval || {}),
      rejectedBy: performedBy,
      rejectedAt: new Date(),
      rejectionReason: remark ? String(remark).trim() : "Payment rejected after approval",
      approvedBy: requestDoc.approval?.approvedBy || null,
      approvedAt: requestDoc.approval?.approvedAt || null,
    };

    await sourceOrder.save({ session });
    await targetOrderDoc.save({ session });
    await requestDoc.save({ session });

    await session.commitTransaction();
    session.endSession();

    return {
      sourceOrder,
      targetOrder: targetOrderDoc,
      request: requestDoc,
      restoredAmount: restoredTotal,
      ledgerUndo,
    };
  } catch (e) {
    try {
      await session.abortTransaction();
    } catch (_) {}
    try {
      session.endSession();
    } catch (_) {}
    throw e;
  }
}
