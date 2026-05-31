/**
 * Replay historical sub-ledger rows into the central ledger using the same
 * shadow handlers and idempotency keys as live traffic (safe to re-run).
 */
import mongoose from "mongoose";
import Order from "../../../models/order.model.js";
import AgriSalesOrder from "../../../models/agriSalesOrder.model.js";
import FarmerPlantOrderLedgerEntry from "../../../models/farmerPlantOrderLedger.model.js";
import RamAgriCustomerLedgerEntry from "../../../models/ramAgriCustomerLedger.model.js";
import DealerLedgerEntry from "../../../models/dealerLedgerEntry.model.js";
import DealerWallet from "../../../models/dealerWallet.js";
import FinancialEvent from "../ledger/models/financialEvent.model.js";
import { EVENT_STATUS } from "../domain/constants.js";
import { roundMoney } from "../domain/roundMoney.js";
import * as shadow from "./financeShadow.js";

const replayOpts = (entry) => ({
  awaitPost: true,
  entryDate: entry?.entryDate || entry?.createdAt || new Date(),
});

function resultLabel(created) {
  const status = created?.status || created?.status;
  if (status === EVENT_STATUS.PROCESSED) {
    return created?.skippedExisting ? "skipped_existing" : "posted";
  }
  if (status === EVENT_STATUS.REJECTED) return "rejected";
  if (status === EVENT_STATUS.FAILED) return "failed";
  if (created === null || created === undefined) return "failed";
  return "skipped";
}

async function wasProcessed(idempotencyKey) {
  const row = await FinancialEvent.findOne({ tenantId: "default", idempotencyKey }).lean();
  return row?.status === EVENT_STATUS.PROCESSED;
}

export function createOrderCache() {
  const map = new Map();
  return {
    async getPlantOrder(orderId) {
      if (!orderId) return null;
      const key = String(orderId);
      if (map.has(key)) return map.get(key);
      const order = await Order.findById(orderId).lean();
      map.set(key, order);
      return order;
    },
    async getAgriOrder(orderId) {
      if (!orderId) return null;
      const key = `agri:${orderId}`;
      if (map.has(key)) return map.get(key);
      const order = await AgriSalesOrder.findById(orderId).lean();
      map.set(key, order);
      return order;
    },
    async getPaymentFromPlantOrder(orderId, paymentId) {
      const order = await this.getPlantOrder(orderId);
      if (!order?.payment?.length || !paymentId) return null;
      return order.payment.find((p) => String(p._id) === String(paymentId)) || null;
    },
    async getPaymentFromAgriOrder(orderId, paymentId) {
      const order = await this.getAgriOrder(orderId);
      if (!order?.payment?.length || !paymentId) return null;
      return order.payment.find((p) => String(p._id) === String(paymentId)) || null;
    },
  };
}

function farmerAdjustmentKind(entry) {
  const tk = String(entry.metadata?.transitionKey || "");
  const cat = String(entry.category || "");
  if (cat === "Advance Transfer" || entry.metadata?.direction) return "ADVANCE_TRANSFER";
  if (cat === "Manual Entry" || entry.metadata?.manualEntryId) return "MANUAL";
  if (tk.startsWith("ORDER_EDIT_DELTA") || /Order Edit (Increase|Decrease)/i.test(cat)) {
    return "ORDER_DELTA";
  }
  if (tk.startsWith("DISPATCH_RETURN") || cat === "Dispatch Return") return "DISPATCH_RETURN";
  if (tk.startsWith("DISPATCH_DAMAGED") || cat === "Dispatch Damaged") return "DISPATCH_DAMAGED";
  if (
    cat === "Order Cancel" ||
    cat === "Order Reject" ||
    tk.includes("_CANCELLED_") ||
    tk.includes("TEMPORARY_CANCELLED")
  ) {
    return "ORDER_CANCEL";
  }
  if (cat === "Order Reopen" || tk.includes("_REJECTED_") || tk.includes("REOPEN")) {
    return "ORDER_REOPEN";
  }
  return "ORDER_DELTA_FALLBACK";
}

/**
 * @returns {Promise<{ status: string, detail?: string }>}
 */
export async function replayFarmerPlantLedgerEntry(entry, ctx) {
  if (!entry) return { status: "skipped_empty" };
  const opts = replayOpts(entry);
  const userId = entry.createdBy;
  const mobile = entry.customerMobile;
  const amount = roundMoney(entry.debit || entry.credit);
  if (amount <= 0 && entry.refType !== "ORDER") {
    return { status: "skipped_zero" };
  }

  if (entry.refType === "ORDER") {
    const order = await ctx.getPlantOrder(entry.orderId);
    if (!order) return { status: "skipped_order_missing" };
    const r = await shadow.shadowFarmerOrderCreated(
      { order, customerMobile: mobile, userId },
      opts
    );
    return { status: resultLabel(r) };
  }

  if (entry.refType === "REVERSAL") {
    const kind = entry.metadata?.kind;
    if (kind === "order_payment_transfer_request" || kind === "order_payment_transfer") {
      const requestId =
        entry.metadata?.transferRequestId ||
        entry.metadata?.transferId ||
        entry.refId;
      const r = await shadow.shadowFarmerPaymentTransfer(
        {
          requestId,
          direction: "REVERSAL",
          amount,
          customerMobile: mobile,
          userId,
        },
        opts
      );
      return { status: resultLabel(r) };
    }
    const order = await ctx.getPlantOrder(entry.orderId);
    const payment =
      (await ctx.getPaymentFromPlantOrder(entry.orderId, entry.paymentId || entry.refId)) ||
      entry.metadata?.paymentSnapshot;
    if (!order || !payment) return { status: "skipped_payment_missing" };
    const r = await shadow.shadowFarmerPayment(
      {
        order,
        payment,
        customerMobile: mobile,
        previousStatus: entry.metadata?.previousStatus || "COLLECTED",
        newStatus: entry.metadata?.newStatus || "REJECTED",
        userId,
      },
      opts
    );
    return { status: resultLabel(r) };
  }

  if (entry.refType === "PAYMENT") {
    const order = await ctx.getPlantOrder(entry.orderId);
    const payment =
      (await ctx.getPaymentFromPlantOrder(entry.orderId, entry.paymentId || entry.refId)) ||
      entry.metadata?.paymentSnapshot;
    if (!order || !payment) return { status: "skipped_payment_missing" };

    const statuses = [];
    const payResult = await shadow.shadowFarmerPayment(
      {
        order,
        payment,
        customerMobile: mobile,
        previousStatus: entry.metadata?.previousStatus ?? null,
        newStatus: entry.metadata?.newStatus ?? "COLLECTED",
        userId,
      },
      opts
    );
    statuses.push(resultLabel(payResult));

    const xferKind = entry.metadata?.kind;
    if (xferKind === "order_payment_transfer_request" || xferKind === "order_payment_transfer") {
      const requestId = entry.metadata?.transferRequestId || entry.metadata?.transferId;
      if (requestId) {
        const xfer = await shadow.shadowFarmerPaymentTransfer(
          {
            requestId,
            direction: "CREDIT",
            amount,
            customerMobile: mobile,
            userId,
          },
          opts
        );
        statuses.push(`xfer:${resultLabel(xfer)}`);
      }
    }
    return { status: statuses.join("|") };
  }

  if (entry.refType === "ADJUSTMENT") {
    const kind = farmerAdjustmentKind(entry);

    if (kind === "ADVANCE_TRANSFER") {
      const transferId = entry.refId || entry.metadata?.transferId;
      const direction = entry.metadata?.direction === "IN" ? "IN" : "OUT";
      const r = await shadow.shadowFarmerAdvanceTransfer(
        { transferId, direction, amount, customerMobile: mobile, userId },
        opts
      );
      return { status: resultLabel(r) };
    }

    if (kind === "MANUAL") {
      const entryId = entry.metadata?.manualEntryId || entry.refId;
      const r = await shadow.shadowFarmerManualAdjustment(
        {
          entryId,
          amount,
          isDebit: (entry.debit || 0) > 0,
          customerMobile: mobile,
          userId,
        },
        opts
      );
      return { status: resultLabel(r) };
    }

    const order = await ctx.getPlantOrder(entry.orderId);
    if (!order) return { status: "skipped_order_missing" };
    const transitionKey = entry.metadata?.transitionKey || `ADJUSTMENT:${entry._id}`;

    if (kind === "ORDER_DELTA" || kind === "ORDER_DELTA_FALLBACK") {
      const isIncrease = (entry.debit || 0) > 0;
      const deltaAmount = isIncrease ? entry.debit : -entry.credit;
      const r = await shadow.shadowFarmerOrderDelta(
        {
          order,
          customerMobile: mobile,
          deltaAmount,
          isIncrease,
          transitionKey,
          userId,
          entryDate: entry.entryDate,
        },
        opts
      );
      return { status: resultLabel(r) };
    }

    if (kind === "ORDER_CANCEL") {
      const r = await shadow.shadowFarmerOrderCancel(
        { order, customerMobile: mobile, amount, userId, transitionKey },
        opts
      );
      return { status: resultLabel(r) };
    }

    if (kind === "ORDER_REOPEN") {
      const r = await shadow.shadowFarmerOrderReopen(
        { order, customerMobile: mobile, amount, userId, transitionKey },
        opts
      );
      return { status: resultLabel(r) };
    }

    if (kind === "DISPATCH_RETURN" || kind === "DISPATCH_DAMAGED") {
      const r = await shadow.shadowFarmerDispatchReturn(
        { order, customerMobile: mobile, amount, transitionKey, userId },
        opts
      );
      return { status: resultLabel(r) };
    }
  }

  return { status: "skipped_unmapped", refType: entry.refType };
}

export async function replayRamAgriLedgerEntry(entry, ctx) {
  if (!entry) return { status: "skipped_empty" };
  const opts = replayOpts(entry);
  let payment = entry.metadata?.paymentSnapshot;
  if (!payment && entry.paymentId && entry.orderId) {
    payment = await ctx.getPaymentFromAgriOrder(entry.orderId, entry.paymentId);
  }
  const r = await shadow.shadowAgriFromLedgerRow(
    {
      entry,
      createdBy: entry.createdBy,
      previousStatus: entry.metadata?.previousPaymentStatus ?? entry.metadata?.previousStatus,
      newStatus: entry.metadata?.newPaymentStatus ?? entry.metadata?.newStatus,
      payment,
    },
    opts
  );
  return { status: resultLabel(r) };
}

export async function replayDealerLedgerEntry(entry, ctx) {
  if (!entry) return { status: "skipped_empty" };
  const opts = replayOpts(entry);
  const userId = entry.createdBy;
  const amount = roundMoney(entry.debit || entry.credit);
  const dealerId = String(entry.dealer);

  if (entry.refType === "ORDER_BOOKING") {
    const order = await ctx.getPlantOrder(entry.orderId);
    if (!order) return { status: "skipped_order_missing" };
    const r = await shadow.shadowDealerOrderBooking(
      { order, dealerId, amount: entry.debit || amount, userId },
      opts
    );
    return { status: resultLabel(r) };
  }

  if (entry.refType === "ORDER_RECEIVABLE_PAYMENT") {
    const order = await ctx.getPlantOrder(entry.orderId);
    const payment = await ctx.getPaymentFromPlantOrder(entry.orderId, entry.paymentId);
    if (!order || !payment) return { status: "skipped_payment_missing" };
    const r = await shadow.shadowDealerReceivablePayment({ order, payment, dealerId, userId }, opts);
    return { status: resultLabel(r) };
  }

  if (
    entry.refType === "REVERSAL" &&
    entry.metadata?.tracksOrderOutstanding &&
    entry.metadata?.reversedReceivablePaymentId &&
    entry.paymentId
  ) {
    const order = await ctx.getPlantOrder(entry.orderId);
    const payment = await ctx.getPaymentFromPlantOrder(entry.orderId, entry.paymentId);
    if (!order || !payment) return { status: "skipped_payment_missing" };
    const r = await shadow.shadowDealerReceivablePaymentReversal({
      order,
      payment,
      dealerId,
      userId,
      newStatus: entry.metadata?.newStatus || "REJECTED",
    }, opts);
    return { status: resultLabel(r) };
  }

  if (
    (entry.refType === "REVERSAL" || entry.refType === "ADJUSTMENT") &&
    entry.metadata?.tracksOrderOutstanding
  ) {
    const order = await ctx.getPlantOrder(entry.orderId);
    if (!order) return { status: "skipped_order_missing" };
    const transitionKey = entry.metadata?.transitionKey || `${entry.refType}:${entry._id}`;
    const cat = String(entry.metadata?.category || "");
    if (cat === "Order Reopen") {
      const r = await shadow.shadowDealerOrderReopen(
        { order, dealerId, amount: entry.debit || amount, userId, transitionKey },
        opts
      );
      return { status: resultLabel(r) };
    }
    if (entry.refType === "REVERSAL" || cat === "Order Cancel" || cat === "Order Reject") {
      const r = await shadow.shadowDealerOrderCancel(
        { order, dealerId, amount: entry.credit || amount, userId, transitionKey },
        opts
      );
      return { status: resultLabel(r) };
    }
  }

  if (entry.refType === "COMMISSION_SETTLEMENT") {
    const settlementId = entry.refId || entry.metadata?.settlementId;
    if (!settlementId) return { status: "skipped_settlement_id" };
    const r = await shadow.shadowDealerCommissionSettlement(
      { dealerId, amount, settlementId, userId },
      opts
    );
    return { status: resultLabel(r) };
  }

  return { status: "skipped_unmapped", refType: entry.refType };
}

export async function replayDealerWalletTransaction(wallet, tx, ctx) {
  if (!wallet?.dealer || !tx?._id) return { status: "skipped_empty" };
  const opts = {
    awaitPost: true,
    entryDate: tx.createdAt || new Date(),
  };
  const amount = Number(tx.amount) || 0;
  if (amount === 0) return { status: "skipped_zero" };

  let farmerPartyId;
  if (tx.relatedOrder) {
    const order = await ctx.getPlantOrder(tx.relatedOrder);
    if (order?.farmer) {
      const Farmer = (await import("../../../models/farmer.model.js")).default;
      const farmer = await Farmer.findById(order.farmer).select("mobileNumber").lean();
      farmerPartyId = farmer?.mobileNumber ? String(farmer.mobileNumber).trim() : undefined;
    }
  }

  const suffix = String(tx._id);
  const idempotencyKey = `dealer:wallet:${wallet.dealer}:${suffix}`;
  if (await wasProcessed(idempotencyKey)) {
    return { status: "skipped_existing" };
  }

  const r = await shadow.shadowDealerWalletMovement(
    {
      dealerId: String(wallet.dealer),
      amount,
      walletCredit: amount < 0,
      farmerPartyId,
      relatedOrderId: tx.relatedOrder ? String(tx.relatedOrder) : undefined,
      userId: tx.performedBy,
      idempotencySuffix: suffix,
    },
    opts
  );
  return { status: resultLabel(r) };
}

export async function replayBankVerifiedPayment({ paymentId, orderMongoId, amount, entryDate, userId }) {
  const opts = { awaitPost: true, entryDate: entryDate || new Date() };
  const idempotencyKey = `bank:verified:${paymentId}`;
  if (await wasProcessed(idempotencyKey)) {
    return { status: "skipped_existing" };
  }
  const r = await shadow.shadowBankPaymentVerified(
    { paymentId, orderMongoId, amount, userId },
    opts
  );
  return { status: resultLabel(r) };
}

async function scanBankVerifiedPayments(onEach) {
  const plantOrders = await Order.find({
    "payment.bankVerificationStatus": "BANK_VERIFIED",
  })
    .select("payment")
    .lean();

  for (const order of plantOrders) {
    for (const p of order.payment || []) {
      if (p.bankVerificationStatus !== "BANK_VERIFIED" && p.paymentStatus !== "BANK_VERIFIED") {
        continue;
      }
      await onEach({
        paymentId: p._id,
        orderMongoId: order._id,
        amount: p.paidAmount,
        entryDate: p.bankEntryDate || p.paymentDate || p.updatedAt,
      });
    }
  }

  const agriOrders = await AgriSalesOrder.find({
    $or: [
      { "payment.bankVerificationStatus": "BANK_VERIFIED" },
      { "payment.paymentStatus": "BANK_VERIFIED" },
    ],
  })
    .select("payment")
    .lean();

  for (const order of agriOrders) {
    for (const p of order.payment || []) {
      if (p.bankVerificationStatus !== "BANK_VERIFIED" && p.paymentStatus !== "BANK_VERIFIED") {
        continue;
      }
      await onEach({
        paymentId: p._id,
        orderMongoId: order._id,
        amount: p.paidAmount,
        entryDate: p.bankEntryDate || p.paymentDate || p.updatedAt,
      });
    }
  }
}

export async function replayAllSubLedgersToCentral({
  sources = ["farmer", "agri", "dealer", "wallet", "bank"],
  batchSize = 200,
  dryRun = false,
  since = null,
  until = null,
  onProgress,
} = {}) {
  const ctx = createOrderCache();
  const stats = {
    farmer: { total: 0, posted: 0, skipped_existing: 0, skipped: 0, failed: 0 },
    agri: { total: 0, posted: 0, skipped_existing: 0, skipped: 0, failed: 0 },
    dealer: { total: 0, posted: 0, skipped_existing: 0, skipped: 0, failed: 0 },
    wallet: { total: 0, posted: 0, skipped_existing: 0, skipped: 0, failed: 0 },
    bank: { total: 0, posted: 0, skipped_existing: 0, skipped: 0, failed: 0 },
  };

  const dateFilter = {};
  if (since) dateFilter.$gte = new Date(since);
  if (until) dateFilter.$lte = new Date(until);
  const entryDateQuery =
    since || until ? { entryDate: dateFilter } : {};

  const bump = (bucket, status) => {
    bucket.total += 1;
    const s = String(status || "");
    if (s.includes("posted")) bucket.posted += 1;
    else if (s.includes("skipped_existing")) bucket.skipped_existing += 1;
    else if (s.includes("failed")) bucket.failed += 1;
    else bucket.skipped += 1;
  };

  if (sources.includes("farmer")) {
    const cursor = FarmerPlantOrderLedgerEntry.find(entryDateQuery)
      .sort({ entryDate: 1, _id: 1 })
      .cursor();
    for await (const entry of cursor) {
      if (dryRun) {
        stats.farmer.total += 1;
        continue;
      }
      const { status } = await replayFarmerPlantLedgerEntry(entry, ctx);
      bump(stats.farmer, status?.startsWith("posted") ? "posted" : status);
      onProgress?.({ source: "farmer", entryId: entry._id, status });
    }
  }

  if (sources.includes("agri")) {
    const cursor = RamAgriCustomerLedgerEntry.find(entryDateQuery)
      .sort({ entryDate: 1, _id: 1 })
      .cursor();
    for await (const entry of cursor) {
      if (dryRun) {
        stats.agri.total += 1;
        continue;
      }
      const { status } = await replayRamAgriLedgerEntry(entry, ctx);
      bump(stats.agri, status);
      onProgress?.({ source: "agri", entryId: entry._id, status });
    }
  }

  if (sources.includes("dealer")) {
    const cursor = DealerLedgerEntry.find(entryDateQuery)
      .sort({ entryDate: 1, _id: 1 })
      .cursor();
    for await (const entry of cursor) {
      if (dryRun) {
        stats.dealer.total += 1;
        continue;
      }
      const { status } = await replayDealerLedgerEntry(entry, ctx);
      bump(stats.dealer, status);
      onProgress?.({ source: "dealer", entryId: entry._id, status });
    }
  }

  if (sources.includes("wallet")) {
    const wallets = await DealerWallet.find({}).select("dealer transactions").lean();
    for (const wallet of wallets) {
      for (const tx of wallet.transactions || []) {
        if (since || until) {
          const d = new Date(tx.createdAt);
          if (since && d < new Date(since)) continue;
          if (until && d > new Date(until)) continue;
        }
        stats.wallet.total += 1;
        if (dryRun) continue;
        const { status } = await replayDealerWalletTransaction(wallet, tx, ctx);
        bump(stats.wallet, status);
        onProgress?.({ source: "wallet", entryId: tx._id, status });
      }
    }
  }

  if (sources.includes("bank")) {
    await scanBankVerifiedPayments(async (pay) => {
      stats.bank.total += 1;
      if (dryRun) return;
      const { status } = await replayBankVerifiedPayment(pay);
      bump(stats.bank, status);
      onProgress?.({ source: "bank", entryId: pay.paymentId, status });
    });
  }

  return stats;
}

export {
  FarmerPlantOrderLedgerEntry,
  RamAgriCustomerLedgerEntry,
  DealerLedgerEntry,
};
