/**
 * Interlink sales returns → Ram Agri customer ledger + MoneyLedger AR (B2B merchant).
 * Append-only: never mutate past ledger rows (use REVERSAL helpers to correct).
 */
import mongoose from "mongoose";
import Merchant from "../models/merchant.model.js";
import { postAgriCustomerEntry } from "./moneyLedger/agriAdapter.js";
import { postEntry, getPartyBalance, roundMoney } from "./moneyLedger/postEntry.js";

async function syncRamAgriMerchantAr(merchantId) {
  if (!merchantId) return;
  const bal = await getPartyBalance({
    book: "RAM_AGRI",
    side: "AR",
    partyType: "MERCHANT",
    partyId: merchantId,
  });
  await Merchant.findByIdAndUpdate(merchantId, { outstandingAmount: bal.balance });
}

/**
 * Stamp order money fields for returns (original bill + cumulative credit).
 * Mutates the mongoose doc; caller saves.
 */
export function applyOrderReturnCreditFields(order, creditAmount) {
  const credit = roundMoney(creditAmount);
  if (!(credit > 0) || !order) return 0;

  if (!(Number(order.originalTotalAmount) > 0)) {
    order.originalTotalAmount = roundMoney(
      Number(order.totalAmount) || 0
    );
  }
  order.returnCreditAmount = roundMoney(
    (Number(order.returnCreditAmount) || 0) + credit
  );
  return credit;
}

/**
 * Post agri sales-return to:
 * 1) RamAgriCustomerLedger (farmers / money-ledger AR farmers view)
 * 2) MoneyLedgerEntry RAM_AGRI AR when order.merchant present (B2B)
 *
 * @returns {{ ok, customerLedger?, moneyLedger?, ledgerStatus, ledgerError }}
 */
export async function postAgriSalesReturnLedgers({
  order,
  creditAmount,
  userId,
  refId,
  idempotencyKey,
  description,
  metadata = {},
  entryDate,
} = {}) {
  const credit = roundMoney(creditAmount);
  if (!(credit > 0)) {
    return { ok: true, skipped: true, ledgerStatus: "SKIPPED" };
  }
  if (!order) return { ok: false, error: "order required", status: 400 };

  const key =
    idempotencyKey ||
    `ram_agri:ar:sales_return:${refId || order._id}:${credit}`;

  let ledgerStatus = "PENDING";
  let ledgerError = "";
  let customerLedger = null;
  let moneyLedger = null;

  try {
    customerLedger = await postAgriCustomerEntry({
      customerMobile: order.customerMobile,
      customerName: order.customerName,
      refType: "SALES_RETURN",
      refId: refId || order._id,
      orderId: order._id,
      credit,
      reference: order.orderNumber,
      category: "Sales Return",
      description:
        description || `Sales return for order ${order.orderNumber || order._id}`,
      entryDate: entryDate || new Date(),
      createdBy: userId,
      idempotencyKey: key,
      metadata: {
        ...metadata,
        source: metadata.source || "AGRI_SALES_RETURN",
      },
    });
    if (!customerLedger?.ok) {
      ledgerStatus = "FAILED";
      ledgerError = customerLedger?.error || "Customer ledger post failed";
      return { ok: false, error: ledgerError, ledgerStatus, ledgerError, customerLedger };
    }
  } catch (e) {
    ledgerStatus = "FAILED";
    ledgerError = e?.message || String(e);
    return { ok: false, error: ledgerError, ledgerStatus, ledgerError };
  }

  const merchantId = order.merchant?._id || order.merchant;
  if (merchantId && mongoose.isValidObjectId(merchantId)) {
    try {
      const merchant = await Merchant.findById(merchantId).select("name").lean();
      moneyLedger = await postEntry({
        book: "RAM_AGRI",
        side: "AR",
        partyType: "MERCHANT",
        partyId: merchantId,
        partyName: merchant?.name || order.customerName || "",
        entryDate: entryDate || new Date(),
        refType: "SALES_RETURN",
        documentType: "AgriSalesOrder",
        documentId: order._id,
        documentNumber: order.orderNumber || "",
        credit,
        description:
          description || `Sales return ${order.orderNumber || ""}`.trim(),
        reference: order.orderNumber || "",
        idempotencyKey: `ram_agri:ar:money:sales_return:${key}`,
        createdBy: userId,
        metadata: {
          ...metadata,
          customerLedgerKey: key,
          agriSalesReturnRefId: refId || null,
        },
      });
      if (!moneyLedger?.ok) {
        ledgerStatus = "FAILED";
        ledgerError = moneyLedger?.error || "Money ledger AR post failed";
        return {
          ok: false,
          error: ledgerError,
          ledgerStatus,
          ledgerError,
          customerLedger,
          moneyLedger,
        };
      }
      await syncRamAgriMerchantAr(merchantId);
    } catch (e) {
      ledgerStatus = "FAILED";
      ledgerError = e?.message || String(e);
      return {
        ok: false,
        error: ledgerError,
        ledgerStatus,
        ledgerError,
        customerLedger,
      };
    }
  }

  ledgerStatus = "POSTED";
  return {
    ok: true,
    ledgerStatus,
    ledgerError: "",
    customerLedger,
    moneyLedger,
    created: !!(customerLedger?.created || moneyLedger?.created),
  };
}

/**
 * One merchant-batch return (possibly FIFO across many sell orders) → ONE Money Ledger AR credit.
 * Order bills/stock are updated separately per order; AR books once for the whole action.
 */
export async function postMerchantBatchSalesReturnMoneyLedger({
  merchantId,
  creditAmount,
  userId,
  groupId,
  orderNumbers = [],
  orderIds = [],
  entryDate,
  metadata = {},
} = {}) {
  const credit = roundMoney(creditAmount);
  if (!(credit > 0)) {
    return { ok: true, skipped: true, ledgerStatus: "SKIPPED" };
  }
  if (!merchantId || !mongoose.isValidObjectId(merchantId)) {
    return { ok: false, error: "merchantId required", status: 400 };
  }
  if (!groupId) {
    return { ok: false, error: "groupId required", status: 400 };
  }

  const merchant = await Merchant.findById(merchantId).select("name").lean();
  const nums = (Array.isArray(orderNumbers) ? orderNumbers : [])
    .map((n) => String(n || "").trim())
    .filter(Boolean);
  const label =
    nums.length === 0
      ? "orders"
      : nums.length === 1
        ? nums[0]
        : `${nums[0]} +${nums.length - 1} more`;

  const moneyLedger = await postEntry({
    book: "RAM_AGRI",
    side: "AR",
    partyType: "MERCHANT",
    partyId: merchantId,
    partyName: merchant?.name || "",
    entryDate: entryDate || new Date(),
    refType: "SALES_RETURN",
    documentType: "Manual",
    documentId: undefined,
    documentNumber: label,
    credit,
    description: `Merchant batch sale return (${nums.length || 0} order${
      nums.length === 1 ? "" : "s"
    }): ${label}`,
    reference: String(groupId),
    idempotencyKey: `ram_agri:ar:money:sales_return:merchant_batch:${groupId}`,
    createdBy: userId,
    metadata: {
      ...metadata,
      merchantBatchGroupId: groupId,
      affectedOrderIds: (Array.isArray(orderIds) ? orderIds : []).map(String),
      affectedOrderNumbers: nums,
      source: "MERCHANT_BATCH_RETURN",
    },
  });

  if (!moneyLedger?.ok) {
    return {
      ok: false,
      error: moneyLedger?.error || "Money ledger AR post failed",
      status: moneyLedger?.status || 400,
      ledgerStatus: "FAILED",
      ledgerError: moneyLedger?.error || "Money ledger AR post failed",
      moneyLedger,
    };
  }

  await syncRamAgriMerchantAr(merchantId);
  return {
    ok: true,
    ledgerStatus: "POSTED",
    ledgerError: "",
    moneyLedger,
    created: !!moneyLedger?.created,
  };
}

/**
 * Classic Biotech sell-order sales return → MoneyLedger AR credit.
 */
export async function postSellReturnAr(sellOrder, { amount, userId, returnId, reason } = {}) {
  const merchantId = sellOrder?.merchant?._id || sellOrder?.merchant;
  if (!merchantId) return { ok: true, skipped: true, reason: "no_merchant" };
  const credit = roundMoney(amount ?? sellOrder.returnAmount);
  if (!(credit > 0)) return { ok: true, skipped: true };

  const merchant = await Merchant.findById(merchantId).select("name").lean();
  const rid = returnId || sellOrder._id;
  const r = await postEntry({
    book: "BIOTECH",
    side: "AR",
    partyType: "MERCHANT",
    partyId: merchantId,
    partyName: merchant?.name || sellOrder.buyerName || "",
    entryDate: new Date(),
    refType: "SALES_RETURN",
    documentType: "SellOrder",
    documentId: sellOrder._id,
    documentNumber: sellOrder.orderNumber || "",
    credit,
    description: `Sales return ${sellOrder.orderNumber || ""} ${reason || ""}`.trim(),
    reference: sellOrder.orderNumber || "",
    idempotencyKey: `biotech:ar:sell_return:${sellOrder._id}:${rid}`,
    createdBy: userId,
    metadata: { returnId: rid, reason: reason || "" },
  });

  const bal = await getPartyBalance({
    book: "BIOTECH",
    side: "AR",
    partyType: "MERCHANT",
    partyId: merchantId,
  });
  await Merchant.findByIdAndUpdate(merchantId, { outstandingAmount: bal.balance });
  return r;
}
