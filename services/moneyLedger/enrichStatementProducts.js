/**
 * Attach product summaries onto ledger statement rows (SELL / PURCHASE / returns).
 */
import GRN from "../../models/grn.model.js";
import AgriSalesOrder from "../../models/agriSalesOrder.model.js";
import PurchaseReturn from "../../models/purchaseReturn.model.js";
import MerchantSellOrder from "../../models/sellOrder.model.js";

function productLabel(item) {
  return (
    item.productName ||
    item.ramAgriVarietyName ||
    item.ramAgriCropName ||
    item.batchNumber ||
    "Item"
  );
}

function linesFromGrn(grn, bookSplit) {
  const out = [];
  for (const item of grn.items || []) {
    if (!(Number(item.acceptedQuantity) > 0)) continue;
    const agri = !!item.isRamAgriProduct;
    if (bookSplit === "classic" && agri) continue;
    if (bookSplit === "ram_agri" && !agri) continue;
    out.push({
      productName: productLabel(item),
      batchNumber: item.batchNumber || "",
      qty: Number(item.acceptedQuantity) || 0,
      rate: Number(item.rate) || 0,
      amount: Number(item.amount) || 0,
      crop: item.ramAgriCropName || "",
      variety: item.ramAgriVarietyName || "",
    });
  }
  return out;
}

function linesFromAgriOrder(order) {
  const lines = Array.isArray(order.lineItems) && order.lineItems.length
    ? order.lineItems
    : null;
  if (lines) {
    return lines.map((l) => ({
      productName: productLabel(l),
      batchNumber: l.batchNumber || "",
      qty: Number(l.quantity) || 0,
      rate: Number(l.rate) || 0,
      amount: Number(l.amount) || Number(l.quantity || 0) * Number(l.rate || 0),
      crop: l.ramAgriCropName || "",
      variety: l.ramAgriVarietyName || "",
    }));
  }
  if (order.productName || order.ramAgriVarietyName || order.ramAgriCropName) {
    return [
      {
        productName: productLabel(order),
        qty: Number(order.quantity) || 0,
        rate: Number(order.rate) || 0,
        amount: Number(order.totalAmount) || 0,
        crop: order.ramAgriCropName || "",
        variety: order.ramAgriVarietyName || "",
      },
    ];
  }
  return [];
}

function linesFromPurchaseReturn(pr) {
  return (pr.lines || [])
    .filter((l) => Number(l.returnQuantity) > 0)
    .map((l) => ({
      productName: productLabel(l),
      batchNumber: l.batchNumber || "",
      qty: Number(l.returnQuantity) || 0,
      rate: Number(l.rate) || 0,
      amount: Number(l.amount) || Number(l.returnQuantity || 0) * Number(l.rate || 0),
      crop: l.ramAgriCropName || "",
      variety: l.ramAgriVarietyName || "",
    }));
}

function linesFromSellOrder(so) {
  return (so.items || so.products || [])
    .map((l) => ({
      productName: l.productName || l.name || l.subtypeName || "Item",
      qty: Number(l.quantity) || Number(l.qty) || 0,
      rate: Number(l.rate) || Number(l.price) || 0,
      amount: Number(l.amount) || 0,
    }))
    .filter((p) => p.qty > 0 || p.productName);
}

function withProducts(e, products) {
  if (!products?.length) return e;
  return {
    ...e,
    metadata: { ...(e.metadata || {}), products },
    productSummary: products
      .slice(0, 4)
      .map((p) => `${p.productName}${p.qty ? ` × ${p.qty}` : ""}`)
      .join(", "),
  };
}

export async function enrichStatementProducts(entries = []) {
  if (!entries.length) return entries;

  const grnIds = [];
  const agriIds = [];
  const prIds = [];
  const sellIds = [];

  for (const e of entries) {
    if (Array.isArray(e.metadata?.products) && e.metadata.products.length) continue;
    if (!e.documentId) continue;
    const ref = String(e.refType || "").toUpperCase();
    const doc = String(e.documentType || "");

    if (doc === "GRN" || ref === "PURCHASE") {
      if (doc === "GRN" || doc === "PurchaseOrder") grnIds.push(e.documentId);
      // PURCHASE often stored with documentType GRN
      if (doc === "GRN") grnIds.push(e.documentId);
    }
    if (
      (doc === "AgriSalesOrder" || ref === "SELL" || ref === "SALES_RETURN") &&
      (doc === "AgriSalesOrder" || e.book === "RAM_AGRI")
    ) {
      if (doc === "AgriSalesOrder") agriIds.push(e.documentId);
    }
    if (doc === "PurchaseReturn" || ref === "PURCHASE_RETURN") {
      if (doc === "PurchaseReturn") prIds.push(e.documentId);
    }
    if (doc === "SellOrder" && (ref === "SELL" || ref === "SALES_RETURN")) {
      sellIds.push(e.documentId);
    }
  }

  const unique = (ids) => [...new Set(ids.map(String))];

  const [grns, agriOrders, prs, sellOrders] = await Promise.all([
    grnIds.length
      ? GRN.find({ _id: { $in: unique(grnIds) } }).select("items").lean()
      : [],
    agriIds.length
      ? AgriSalesOrder.find({ _id: { $in: unique(agriIds) } })
          .select(
            "lineItems productName quantity rate totalAmount ramAgriCropName ramAgriVarietyName"
          )
          .lean()
      : [],
    prIds.length
      ? PurchaseReturn.find({ _id: { $in: unique(prIds) } }).select("lines").lean()
      : [],
    sellIds.length
      ? MerchantSellOrder.find({ _id: { $in: unique(sellIds) } })
          .select("items products")
          .lean()
      : [],
  ]);

  const grnById = new Map(grns.map((g) => [String(g._id), g]));
  const agriById = new Map(agriOrders.map((o) => [String(o._id), o]));
  const prById = new Map(prs.map((p) => [String(p._id), p]));
  const sellById = new Map(sellOrders.map((s) => [String(s._id), s]));

  return entries.map((e) => {
    if (Array.isArray(e.metadata?.products) && e.metadata.products.length) {
      return {
        ...e,
        productSummary:
          e.productSummary ||
          e.metadata.products
            .slice(0, 4)
            .map((p) => `${p.productName || p.variety || "Item"}${p.qty ? ` × ${p.qty}` : ""}`)
            .join(", "),
      };
    }
    if (!e.documentId) return e;

    const ref = String(e.refType || "").toUpperCase();
    const doc = String(e.documentType || "");
    const id = String(e.documentId);

    if (doc === "GRN" || (ref === "PURCHASE" && grnById.has(id))) {
      const grn = grnById.get(id);
      if (!grn) return e;
      const bookSplit = e.metadata?.bookSplit || (e.book === "RAM_AGRI" ? "ram_agri" : "classic");
      return withProducts(e, linesFromGrn(grn, bookSplit));
    }

    if (doc === "AgriSalesOrder" && (ref === "SELL" || ref === "SALES_RETURN" || !ref)) {
      const order = agriById.get(id);
      if (!order) return e;
      return withProducts(e, linesFromAgriOrder(order));
    }

    if (doc === "PurchaseReturn" || ref === "PURCHASE_RETURN") {
      const pr = prById.get(id);
      if (!pr) return e;
      return withProducts(e, linesFromPurchaseReturn(pr));
    }

    if (doc === "SellOrder" && (ref === "SELL" || ref === "SALES_RETURN")) {
      const so = sellById.get(id);
      if (!so) return e;
      return withProducts(e, linesFromSellOrder(so));
    }

    return e;
  });
}
