import mongoose from "mongoose";
import AgriSalesOrder, {
  rollupAgriLineItemsToRoot,
  getAgriOrderLines,
} from "../models/agriSalesOrder.model.js";
import RamAgriSalesConfig from "../models/ramAgriSalesConfig.model.js";
import User from "../models/user.model.js";
import AppError from "../utility/appError.js";

const CONFIG_KEY = "default";

const terminalStatuses = ["CANCELLED", "REJECTED"];

/**
 * @returns {Promise<{ defaultOutstandingLimitRupees: number, _id?: import("mongoose").Types.ObjectId }>}
 */
export async function getOrCreateRamAgriSalesConfig() {
  let doc = await RamAgriSalesConfig.findOne({ key: CONFIG_KEY });
  if (!doc) {
    doc = await RamAgriSalesConfig.create({
      key: CONFIG_KEY,
      defaultOutstandingLimitRupees: DEFAULT_RAM_AGRI_OUTSTANDING_LIMIT_RUPEES,
    });
  }
  return doc;
}

export async function getGlobalDefaultOutstandingLimitRupees() {
  const doc = await getOrCreateRamAgriSalesConfig();
  const v = Number(doc.defaultOutstandingLimitRupees);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_RAM_AGRI_OUTSTANDING_LIMIT_RUPEES;
}

/**
 * @param {number} rupees
 * @param {import("mongoose").Types.ObjectId|string|null} updatedBy
 */
export async function setGlobalDefaultOutstandingLimitRupees(rupees, updatedBy) {
  const n = Number(rupees);
  if (!Number.isFinite(n) || n < 0) {
    throw new AppError("defaultOutstandingLimitRupees must be a non-negative number", 400);
  }
  await RamAgriSalesConfig.findOneAndUpdate(
    { key: CONFIG_KEY },
    {
      $set: {
        defaultOutstandingLimitRupees: n,
        ...(updatedBy ? { updatedBy } : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/**
 * Resolved cap for a sales user (per-user override or global default).
 * @param {import("mongoose").Types.ObjectId|string|null|undefined} userId
 */
export async function getEffectiveOutstandingLimitRupees(userId) {
  if (!userId || !mongoose.isValidObjectId(String(userId))) {
    return getGlobalDefaultOutstandingLimitRupees();
  }
  const u = await User.findById(userId).select("ramAgriOutstandingLimitRupees").lean();
  const override = u?.ramAgriOutstandingLimitRupees;
  if (override != null && Number.isFinite(Number(override)) && Number(override) >= 0) {
    return Number(override);
  }
  return getGlobalDefaultOutstandingLimitRupees();
}

/**
 * Sum of balanceAmount for orders attributed to this sales user (salesPerson ?? createdBy).
 * @param {import("mongoose").Types.ObjectId|string} salesUserId
 */
export async function aggregateOutstandingForSalesUser(salesUserId) {
  if (!salesUserId || !mongoose.isValidObjectId(String(salesUserId))) {
    return 0;
  }
  const oid = new mongoose.Types.ObjectId(String(salesUserId));
  const rows = await AgriSalesOrder.aggregate([
    {
      $addFields: {
        effectiveSalesId: { $ifNull: ["$salesPerson", "$createdBy"] },
      },
    },
    {
      $match: {
        effectiveSalesId: oid,
        balanceAmount: { $gt: 0 },
        orderStatus: { $nin: terminalStatuses },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: { $ifNull: ["$balanceAmount", 0] } },
      },
    },
  ]);
  const raw = rows[0]?.total ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * @param {object} params
 * @param {import("mongoose").Types.ObjectId|string} params.salesPersonId
 * @param {number} params.additionalExposureRupees — unpaid portion of the new/changed order
 */
export async function assertOutstandingAllowsNewExposure({
  salesPersonId,
  additionalExposureRupees,
}) {
  const add = Number(additionalExposureRupees);
  if (!Number.isFinite(add) || add <= 0) {
    return;
  }
  const limit = await getEffectiveOutstandingLimitRupees(salesPersonId);
  const current = await aggregateOutstandingForSalesUser(salesPersonId);
  const projected = current + add;
  if (projected > limit + 1e-6) {
    throw new AppError(
      `Ram Agri sales outstanding limit exceeded for this sales person. Current outstanding: ₹${current.toFixed(
        2
      )}, new order unpaid: ₹${add.toFixed(2)}, limit: ₹${limit.toFixed(
        2
      )}. Reduce the unpaid portion or collect payment before placing the order.`,
      400
    );
  }
}

/**
 * @param {import("mongoose").Types.ObjectId|string} salesUserId
 */
export async function getOutstandingSummaryForSalesUser(salesUserId) {
  const limit = await getEffectiveOutstandingLimitRupees(salesUserId);
  const outstanding = await aggregateOutstandingForSalesUser(salesUserId);
  const remaining = Math.max(0, Math.round((limit - outstanding) * 100) / 100);
  return {
    outstanding,
    limit,
    remaining,
    overLimit: outstanding > limit + 1e-6,
    defaultGlobalLimit: await getGlobalDefaultOutstandingLimitRupees(),
  };
}

function hasLineItems(doc) {
  return Array.isArray(doc?.lineItems) && doc.lineItems.length > 0;
}

/**
 * Mirrors balance calculation after pre-save rollup for open orders (edit preview).
 * @param {object} doc — mongoose doc or plain object (may be mutated)
 */
export function projectProvisionalBalanceAmount(doc) {
  const o = doc;
  if (hasLineItems(o)) {
    rollupAgriLineItemsToRoot(o);
  } else {
    const quantityForAmount =
      o.orderStatus === "COMPLETED" && Number(o.deliveredQuantity) > 0
        ? Number(o.deliveredQuantity)
        : Number(o.quantity) || 0;
    o.totalAmount = quantityForAmount * (Number(o.rate) || 0);
  }
  const totalPaid =
    o.payment && o.payment.length
      ? o.payment.reduce(
          (sum, p) =>
            p.paymentStatus === "COLLECTED" ? sum + (Number(p.paidAmount) || 0) : sum,
          0
        )
      : 0;
  return Math.round(((o.totalAmount || 0) - totalPaid) * 100) / 100;
}

/** True if order touches Ram Agri input lines (limit applies). */
export function orderRequiresRamAgriOutstandingLimit(orderLike) {
  const lines = getAgriOrderLines(orderLike);
  return lines.some((l) => l.isRamAgriProduct || l.ramAgriCropId);
}

/**
 * When updating an order, portfolio outstanding replaces this order's old balance with new balance.
 */
export async function assertOutstandingAllowsOrderUpdate({
  salesPersonId,
  previousBalanceAmount,
  provisionalNewBalanceAmount,
}) {
  const add =
    Number(provisionalNewBalanceAmount) - Number(previousBalanceAmount || 0);
  if (!Number.isFinite(add) || add <= 0) {
    return;
  }
  const limit = await getEffectiveOutstandingLimitRupees(salesPersonId);
  const total = await aggregateOutstandingForSalesUser(salesPersonId);
  const projected = total + add;
  if (projected > limit + 1e-6) {
    throw new AppError(
      `Ram Agri sales outstanding limit exceeded. Current portfolio outstanding: ₹${total.toFixed(
        2
      )}, this order balance increases by ₹${add.toFixed(2)}, limit: ₹${limit.toFixed(2)}.`,
      400
    );
  }
}
