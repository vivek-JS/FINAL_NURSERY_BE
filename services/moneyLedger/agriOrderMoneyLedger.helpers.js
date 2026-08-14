/**
 * Helpers for agri B2B create → MoneyLedger SELL posts (with soft retry).
 */
import mongoose from "mongoose";
import AgriSalesOrder from "../../models/agriSalesOrder.model.js";
import Merchant from "../../models/merchant.model.js";
import { postAgriSalesOrderAr } from "./agriSellPosts.js";

export function resolveMerchantBody(body = {}) {
  return body.merchant || body.merchantId || null;
}

/**
 * @returns {{ orderChannel: 'B2B'|'RETAIL', merchantId: import('mongoose').Types.ObjectId|null, merchantDoc: object|null, error?: string, status?: number }}
 */
export async function resolveAgriB2bMerchant({ orderChannelBody, merchantBody }) {
  let orderChannel =
    String(orderChannelBody || "RETAIL").toUpperCase() === "B2B" ? "B2B" : "RETAIL";

  if (!merchantBody) {
    if (orderChannel === "B2B") {
      return {
        orderChannel,
        merchantId: null,
        merchantDoc: null,
        error: "Merchant is required for B2B agri sales orders",
        status: 400,
      };
    }
    return { orderChannel, merchantId: null, merchantDoc: null };
  }

  if (!mongoose.isValidObjectId(merchantBody)) {
    return {
      orderChannel,
      merchantId: null,
      merchantDoc: null,
      error: "Invalid merchant ID",
      status: 400,
    };
  }

  const merchantDoc = await Merchant.findById(merchantBody).select("_id name phone isActive").lean();
  if (!merchantDoc) {
    return {
      orderChannel,
      merchantId: null,
      merchantDoc: null,
      error: "Merchant not found",
      status: 404,
    };
  }
  if (merchantDoc.isActive === false) {
    return {
      orderChannel,
      merchantId: null,
      merchantDoc: null,
      error: "Merchant is inactive",
      status: 400,
    };
  }

  return {
    orderChannel: "B2B",
    merchantId: merchantDoc._id,
    merchantDoc,
  };
}

function sellPostedOk(result) {
  if (!result) return false;
  if (result.skipped) return true;
  if (result.ok === false) return false;
  if (result.sellPost && result.sellPost.ok === false) return false;
  return result.ok !== false;
}

/**
 * Post money ledger for B2B agri order. Soft: never throws; retries once on failure.
 */
export async function postAgriB2bMoneyLedgerSoft(order, userId, { attempts = 2 } = {}) {
  const merchantId = order?.merchant?._id || order?.merchant;
  if (!merchantId) {
    return {
      posted: false,
      skipped: true,
      reason: "no_merchant",
      retryAvailable: false,
    };
  }

  let lastError = null;
  let lastResult = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      lastResult = await postAgriSalesOrderAr(order, userId);
      if (sellPostedOk(lastResult)) {
        return {
          posted: !lastResult?.skipped,
          skipped: Boolean(lastResult?.skipped),
          reason: lastResult?.reason || undefined,
          retryAvailable: false,
          result: lastResult,
          attempts: i + 1,
        };
      }
      lastError =
        lastResult?.sellPost?.error || lastResult?.error || "Money ledger post failed";
    } catch (e) {
      lastError = e?.message || String(e);
    }
  }

  return {
    posted: false,
    skipped: false,
    error: lastError || "Money ledger post failed",
    retryAvailable: true,
    result: lastResult,
    attempts,
  };
}

/**
 * Manual / soft retry for an existing B2B agri order.
 */
export async function retryAgriSalesOrderMoneyLedgerById(orderId, userId) {
  if (!mongoose.isValidObjectId(orderId)) {
    return { ok: false, status: 400, error: "Invalid order ID" };
  }

  const order = await AgriSalesOrder.findById(orderId);
  if (!order) {
    return { ok: false, status: 404, error: "Agri sales order not found" };
  }

  const status = String(order.orderStatus || "").toUpperCase();
  if (status === "CANCELLED" || status === "REJECTED") {
    return {
      ok: false,
      status: 400,
      error: `Cannot post money ledger for ${status} order`,
    };
  }

  const merchantId = order.merchant;
  if (!merchantId) {
    return {
      ok: false,
      status: 400,
      error: "Order has no merchant — not a B2B money-ledger sale",
    };
  }

  const ledger = await postAgriB2bMoneyLedgerSoft(order, userId, { attempts: 2 });
  if (ledger.posted || ledger.skipped) {
    return { ok: true, status: 200, moneyLedger: ledger, order };
  }
  return {
    ok: false,
    status: 502,
    error: ledger.error || "Money ledger retry failed",
    moneyLedger: ledger,
    order,
  };
}
