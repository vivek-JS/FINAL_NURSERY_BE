import mongoose from "mongoose";
import Farmer from "../models/farmer.model.js";
import User from "../models/user.model.js";
import FarmerPlantOrderLedgerEntry from "../models/farmerPlantOrderLedger.model.js";
import FarmerPlantOrderArchive from "../models/farmerPlantOrderArchive.model.js";

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
  if (!previousStatus || !newStatus) return "INVALID";
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

/** Customer identity for farmer-plant ledger (farmer plant orders only). */
export function hasFarmerPlantLedgerIdentity(order) {
  if (!order) return false;
  if (order.farmer?._id || order.farmer) return true;
  const of = order.orderFor;
  return Boolean(of && String(of.name || "").trim());
}

export const shouldLogFarmerPlantLedger = (order) => {
  if (!order) return false;
  if (order.dealerOrder) return false;
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
  if (order.dealerOrder && order.dealer) {
    return order.dealer._id || order.dealer;
  }
  if (order.dealer) {
    return order.dealer._id || order.dealer;
  }
  if (order.salesPerson) {
    const spId = order.salesPerson._id || order.salesPerson;
    const sp = await User.findById(spId).select("jobTitle").lean();
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
    metadata,
  };

  if (session) {
    try {
      const created = await FarmerPlantOrderLedgerEntry.create(
        [entryPayload],
        { session }
      );
      return created[0];
    } catch (e) {
      if (e.code === 11000) return null;
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
      orderNumericId: order.orderId,
      dealerOrder: Boolean(order.dealerOrder),
      ...(fundingMeta ? { fundingDealerId: fundingMeta } : {}),
    },
    session,
  });
  if (created) return created;
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
    return createFarmerPlantLedgerEntry({
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
  }

  // action === "REVERSAL"
  const defaultReversalDesc = `Payment no longer collected (${previousStatus} → ${newStatus})`;
  return createFarmerPlantLedgerEntry({
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

  return null;
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
  if (!shouldLogFarmerPlantLedger(updatedDoc)) return;

  try {
    await ensureFarmerPlantOrderDebit(updatedDoc, { userId, session });
  } catch (e) {
    console.error("ensureFarmerPlantOrderDebit failed:", e);
    if (strict) throw e;
  }

  try {
    const { syncDealerLedgerForOrder } = await import("./dealerLedgerHelper.js");
    await syncDealerLedgerForOrder(updatedDoc, { userId, session });
  } catch (e) {
    console.error("syncDealerLedgerForOrder failed:", e);
    if (strict) throw e;
  }

  // Order total edit transition: write immutable delta adjustment rows for rate/quantity changes.
  // Skip when previous state is terminal to avoid double-counting with reopen logic.
  try {
    const oid = updatedDoc?._id;
    const prevStatus = existingDoc?.orderStatus;
    const nextStatus = updatedDoc?.orderStatus;
    const terminalStatuses = ["CANCELLED", "REJECTED"];
    const prevIsTerminal = terminalStatuses.includes(prevStatus);

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

          // Terminal: cancel or reject — reverse current principal for the order.
          if (nextStatus === "CANCELLED" || nextStatus === "REJECTED") {
            const isCancel = nextStatus === "CANCELLED";
            await createFarmerPlantLedgerEntry({
              customerMobile,
              customerName,
              farmerId,
              refType: "ADJUSTMENT",
              refId: oid,
              orderId: oid,
              credit: lineTotal,
              reference: String(updatedDoc.orderId ?? ""),
              category: isCancel ? "Order Cancel" : "Order Reject",
              description: isCancel
                ? `Order ${updatedDoc.orderId ?? ""} cancelled — reverse order debit`
                : `Order ${updatedDoc.orderId ?? ""} rejected — reverse order debit`,
              entryDate,
              createdBy: userId,
              metadata: { transitionKey, previousStatus: prevStatus, newStatus: nextStatus },
              session,
            });
          } else if (prevStatus === "CANCELLED" || prevStatus === "REJECTED") {
            // Re-open from CANCELLED or REJECTED: restore order debit so receivable returns.
            const fromReject = prevStatus === "REJECTED";
            await createFarmerPlantLedgerEntry({
              customerMobile,
              customerName,
              farmerId,
              refType: "ADJUSTMENT",
              refId: oid,
              orderId: oid,
              debit: lineTotal,
              reference: String(updatedDoc.orderId ?? ""),
              category: "Order Reopen",
              description: fromReject
                ? `Order ${updatedDoc.orderId ?? ""} reopened from rejected — restore order debit`
                : `Order ${updatedDoc.orderId ?? ""} reopened — restore order debit`,
              entryDate,
              createdBy: userId,
              metadata: { transitionKey, previousStatus: prevStatus, newStatus: nextStatus },
              session,
            });
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
