/**
 * Attach product summaries onto ledger statement rows (legacy rows without metadata.products).
 */
import GRN from "../../models/grn.model.js";

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

export async function enrichStatementProducts(entries = []) {
  const needIds = [];
  for (const e of entries) {
    if (e.documentType !== "GRN" || !e.documentId) continue;
    if (Array.isArray(e.metadata?.products) && e.metadata.products.length) continue;
    needIds.push(e.documentId);
  }
  if (!needIds.length) return entries;

  const grns = await GRN.find({ _id: { $in: needIds } })
    .select("items")
    .lean();
  const byId = new Map(grns.map((g) => [String(g._id), g]));

  return entries.map((e) => {
    if (e.documentType !== "GRN" || !e.documentId) return e;
    if (Array.isArray(e.metadata?.products) && e.metadata.products.length) return e;
    const grn = byId.get(String(e.documentId));
    if (!grn) return e;
    const bookSplit = e.metadata?.bookSplit || (e.book === "RAM_AGRI" ? "ram_agri" : "classic");
    const products = linesFromGrn(grn, bookSplit);
    if (!products.length) return e;
    return {
      ...e,
      metadata: { ...(e.metadata || {}), products },
      productSummary: products
        .slice(0, 4)
        .map((p) => `${p.productName}${p.qty ? ` × ${p.qty}` : ""}`)
        .join(", "),
    };
  });
}
