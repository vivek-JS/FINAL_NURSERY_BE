import Product from "../models/product.model.js";
import { InventoryProduct } from "../models/inventory.model.js";
import { isGiftInventoryCategory } from "../utils/linkedDispatchLoad.util.js";

/** Resolve gift SKU from new Product master or legacy InventoryProduct. */
export async function findGiftProductById(productId, { populateUnit = true } = {}) {
  if (!productId) return null;

  let product = await Product.findById(productId);
  if (product && isGiftInventoryCategory(product.category)) {
    if (populateUnit) {
      await product.populate("primaryUnit", "name abbreviation");
    }
    return { product, source: "product" };
  }

  product = await InventoryProduct.findById(productId);
  if (product && isGiftInventoryCategory(product.category)) {
    return { product, source: "inventory" };
  }

  return null;
}

export async function listGiftProductsInStock() {
  const rows = await Product.find({
    category: { $regex: /^gift$/i },
    isActive: { $ne: false },
    currentStock: { $gt: 0 },
  })
    .populate("primaryUnit", "name abbreviation")
    .sort({ name: 1 })
    .lean();

  return rows.map((p) => ({
    _id: p._id,
    code: p.code,
    name: p.name,
    category: p.category,
    currentStock: Number(p.currentStock) || 0,
    averagePrice: Number(p.averagePrice) || 0,
    primaryUnit: p.primaryUnit || null,
    unitAbbreviation: p.primaryUnit?.abbreviation || p.primaryUnit?.name || "",
  }));
}

export function resolveGiftProductRate(product, rateInput) {
  let resolvedRate = Number(rateInput);
  if (Number.isNaN(resolvedRate) || resolvedRate <= 0) {
    resolvedRate = Number(product.averagePrice) || Number(product.sellingPrice) || 0;
  }
  return resolvedRate;
}

export function giftProductUnitLabel(product, source) {
  if (source === "product") {
    return (
      product.primaryUnit?.abbreviation ||
      product.primaryUnit?.name ||
      ""
    );
  }
  return product.unit || "";
}
