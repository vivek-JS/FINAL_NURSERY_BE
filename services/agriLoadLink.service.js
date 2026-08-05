import mongoose from "mongoose";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import Order from "../models/order.model.js";
import User from "../models/user.model.js";
import {
  getAgriLoadWhitelist,
  normalizePhoneForWhitelist,
} from "../utils/agriLoadLinkSigner.js";
import { isLinkedAgriLoadSatisfied } from "./linkedAgriLoadGuard.service.js";
import { retryNurseryOrderDcAfterAgriLoaded } from "./dispatchPostLoadFinalize.service.js";
import { pushAgriActivityAndEmit } from "../utils/orderEventDualWrite.js";

export function resolvePublicFrontendBaseUrl() {
  const raw =
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_ACTION_BASE_URL ||
    process.env.API_BASE_URL ||
    "";
  const base = (
    raw && !raw.includes("YOUR_DOMAIN") ? raw : "https://erp.rambiotechplants.com"
  )
    .trim()
    .replace(/\/+$/, "");
  return base;
}

/** WhatsApp link → React /agri-load page (not raw API — avoids SPA 404 on prod). */
export function buildAgriLoadConfirmPageUrl({ orderRef, actorPhone, agriOrderNumbers = [] } = {}) {
  const base = resolvePublicFrontendBaseUrl();
  if (!base) return "";

  const ref = String(orderRef || agriOrderNumbers[0] || "").trim();
  const phone = normalizePhoneForWhitelist(actorPhone || "");
  if (!ref || !phone) return "";

  const params = new URLSearchParams({
    orderRef: ref,
    actorPhone: phone,
  });
  const agriList = (Array.isArray(agriOrderNumbers) ? agriOrderNumbers : [])
    .map((n) => String(n || "").trim())
    .filter(Boolean);
  if (agriList.length) {
    params.set("agriOrders", agriList.join(","));
  }
  return `${base}/agri-load?${params.toString()}`;
}

export function assertActorPhoneWhitelisted(actorPhone) {
  const normalized = normalizePhoneForWhitelist(actorPhone || "");
  const whitelist = new Set(getAgriLoadWhitelist());
  if (!normalized || !whitelist.has(normalized)) {
    const err = new Error("Not authorized for this action");
    err.statusCode = 403;
    throw err;
  }
  return normalized;
}

export async function findLinkedAgriOrdersByRef(orderRef) {
  const raw = String(orderRef || "").trim();
  if (!raw) return [];

  const upper = raw.toUpperCase();
  const baseFilter = {
    linkedNurseryOrderId: { $ne: null },
    orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
  };

  if (upper.startsWith("AGR-")) {
    const one = await AgriSalesOrder.findOne({ orderNumber: upper, ...baseFilter });
    return one ? [one] : [];
  }

  if (mongoose.isValidObjectId(raw)) {
    const byId = await AgriSalesOrder.findOne({ _id: raw, ...baseFilter });
    if (byId) return [byId];
    return AgriSalesOrder.find({ linkedNurseryOrderId: raw, ...baseFilter });
  }

  const byCode = await AgriSalesOrder.find({
    linkedNurseryOrderCode: raw,
    ...baseFilter,
  });
  if (byCode.length) return byCode;

  const byAgriNumber = await AgriSalesOrder.findOne({ orderNumber: upper, ...baseFilter });
  return byAgriNumber ? [byAgriNumber] : [];
}

/** Resolve pending linked agri rows from nursery code (1031), AGR-…, or Mongo id. */
export async function findPendingLinkedAgriOrdersByRef(orderRef) {
  const orders = await findLinkedAgriOrdersByRef(orderRef);
  return orders.filter((o) => !isLinkedAgriLoadSatisfied(o));
}

export async function previewAgriLoadLink({ orderRef, agriOrderNumbers = [] } = {}) {
  let orders = [];
  const explicit = (Array.isArray(agriOrderNumbers) ? agriOrderNumbers : [])
    .map((n) => String(n || "").trim().toUpperCase())
    .filter(Boolean);

  if (explicit.length) {
    orders = await AgriSalesOrder.find({
      orderNumber: { $in: explicit },
      linkedNurseryOrderId: { $ne: null },
      orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
    }).lean();
  } else {
    orders = await findLinkedAgriOrdersByRef(orderRef);
  }

  if (!orders.length) {
    return { found: false, items: [] };
  }

  const nurseryIds = [...new Set(orders.map((o) => String(o.linkedNurseryOrderId || "")).filter(Boolean))];
  const nurseryDocs = nurseryIds.length
    ? await Order.find({ _id: { $in: nurseryIds } })
        .select("orderId deliveryDate currentDispatchId")
        .lean()
    : [];
  const nurseryById = new Map(nurseryDocs.map((n) => [String(n._id), n]));

  const items = orders.map((o) => ({
    agriOrderId: o._id,
    agriOrderNumber: o.orderNumber,
    productName: o.productName,
    quantity: o.quantity,
    linkedNurseryOrderCode: o.linkedNurseryOrderCode || "",
    linkedNurseryOrderId: o.linkedNurseryOrderId,
    agriLoadStatus: o.agriLoadStatus || "PENDING_LOAD",
    isLoaded: isLinkedAgriLoadSatisfied(o),
  }));

  const firstNursery = nurseryById.get(String(orders[0]?.linkedNurseryOrderId || ""));
  return {
    found: true,
    nurseryOrderCode: firstNursery?.orderId || orders[0]?.linkedNurseryOrderCode || "",
    items,
    allLoaded: items.every((i) => i.isLoaded),
  };
}

async function resolveAuditUser(actorPhone) {
  const fallback = await User.findOne({
    $or: [{ role: "SUPER_ADMIN" }, { jobTitle: "SUPER_ADMIN" }],
  })
    .select("_id name")
    .lean();
  return fallback || null;
}

/**
 * Mark linked agri order(s) LOADED + retry nursery DC. Returns summary for API/UI.
 */
export async function confirmAgriLoadViaLink({
  orderRef,
  agriOrderNumbers = [],
  actorPhone,
} = {}) {
  const normalizedActorPhone = assertActorPhoneWhitelisted(actorPhone);
  const auditUser = await resolveAuditUser(normalizedActorPhone);
  const performedByName = auditUser?.name || `LINK:${normalizedActorPhone}`;

  let targets = [];
  const explicit = (Array.isArray(agriOrderNumbers) ? agriOrderNumbers : [])
    .map((n) => String(n || "").trim().toUpperCase())
    .filter(Boolean);

  if (explicit.length) {
    targets = await AgriSalesOrder.find({
      orderNumber: { $in: explicit },
      linkedNurseryOrderId: { $ne: null },
      orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
    });
  } else {
    targets = await findPendingLinkedAgriOrdersByRef(orderRef);
  }

  if (!targets.length) {
    const err = new Error("No linked agri orders found for this link");
    err.statusCode = 404;
    throw err;
  }

  const marked = [];
  const already = [];
  const nurseryIds = new Set();

  for (const order of targets) {
    if (!order.linkedNurseryOrderId) continue;
    nurseryIds.add(String(order.linkedNurseryOrderId));

    if (isLinkedAgriLoadSatisfied(order)) {
      already.push(order.orderNumber);
      continue;
    }

    if (!auditUser?._id) {
      const err = new Error("Cannot resolve audit user for one-click action");
      err.statusCode = 500;
      throw err;
    }

    order.agriLoadStatus = "LOADED";
    order.loadedAt = new Date();
    order.loadedBy = auditUser._id;
    pushAgriActivityAndEmit(
      order,
      {
        action: "DISPATCH_UPDATED",
        description: `Agri load marked LOADED via confirm link by ${normalizedActorPhone}.`,
        performedBy: auditUser._id,
        performedByName,
        metadata: {
          agriLoadStatus: "LOADED",
          loadedAt: order.loadedAt,
          source: "WHATSAPP_CONFIRM_LINK",
          actorPhone: normalizedActorPhone,
        },
      },
      { userId: auditUser._id, actorName: performedByName }
    );
    await order.save();
    marked.push(order.orderNumber);
  }

  for (const nurseryId of nurseryIds) {
    void retryNurseryOrderDcAfterAgriLoaded(nurseryId, {
      changedBy: performedByName,
    }).catch((e) => console.error("[Agri Load Link] DC retry:", e?.message || e));
  }

  return {
    marked,
    alreadyLoaded: already,
    nurseryOrderCodes: [
      ...new Set(
        targets.map((o) => String(o.linkedNurseryOrderCode || "").trim()).filter(Boolean)
      ),
    ],
    actorPhone: normalizedActorPhone,
  };
}

export async function notifyAdminsAgriLoadConfirmed(summary) {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") return;

  const marked = summary?.marked || [];
  const already = summary?.alreadyLoaded || [];
  if (!marked.length && !already.length) return;

  try {
    const { alertAdmins } = await import("./whatsappAlertService.js");
    const lines = ["✅ *Agri Load confirmed*"];
    if (marked.length) {
      lines.push(`Marked LOADED: ${marked.join(", ")}`);
    }
    if (already.length) {
      lines.push(`Already loaded: ${already.join(", ")}`);
    }
    if (summary?.nurseryOrderCodes?.length) {
      lines.push(`Nursery order(s): ${summary.nurseryOrderCodes.join(", ")}`);
    }
    lines.push(`Confirmed by: ${summary?.actorPhone || "—"}`);
    lines.push("Nursery DC will generate when shed load is complete.");
    await alertAdmins(lines.join("\n"), "agri load confirmed");
  } catch (e) {
    console.error("[Agri Load Link] admin notify:", e?.message || e);
  }
}
