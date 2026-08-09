import mongoose from "mongoose";
import Product from "../models/product.model.js";
import InventoryTransaction from "../models/inventoryTransaction.model.js";

const parseNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const typeFromTxn = (txn) => {
  if (txn.transactionType === "inward" || txn.transactionType === "return") return "CREDIT";
  if (txn.transactionType === "outward") return "DEBIT";
  if (txn.transactionType === "adjustment") {
    return parseNum(txn.quantity) >= 0 ? "CREDIT" : "DEBIT";
  }
  if (txn.transactionType === "transfer") {
    return parseNum(txn.quantity) >= 0 ? "CREDIT" : "DEBIT";
  }
  return parseNum(txn.quantity) >= 0 ? "CREDIT" : "DEBIT";
};

const categoryLabel = (txn) => {
  if (txn.metadata?.isBiotechTransfer) return "Agri → Biotech transfer";
  const ref = txn.referenceType || txn.transactionType;
  const map = {
    GRN: "GRN inward",
    Outward: "Stock outward",
    Adjustment: "Adjustment",
    Transfer: "Transfer",
    SellOrder: "Sell order",
    ReturnRequest: "Return",
    PurchaseOrder: "Purchase order",
  };
  return map[ref] || String(ref || txn.transactionType || "Movement");
};

export async function buildProductStockLedger(productId, { startDate = null, endDate = null } = {}) {
  if (!mongoose.isValidObjectId(productId)) {
    throw new Error("Invalid product ID");
  }

  const product = await Product.findById(productId)
    .select("_id code name category currentStock plantId subtypeId")
    .lean();
  if (!product) throw new Error("Product not found");
  if (!/^seeds$/i.test(String(product.category || ""))) {
    throw new Error("Stock ledger is only available for seed products");
  }

  const query = { product: product._id };
  if (startDate || endDate) {
    query.transactionDate = {};
    if (startDate) query.transactionDate.$gte = new Date(startDate);
    if (endDate) query.transactionDate.$lte = new Date(`${endDate}T23:59:59.999Z`);
  }

  const txns = await InventoryTransaction.find(query)
    .populate("batch", "batchNumber")
    .sort({ transactionDate: 1, _id: 1 })
    .lean();

  const ledgerEntries = txns.map((txn) => {
    const type = typeFromTxn(txn);
    const qty = Math.abs(parseNum(txn.quantity));
    return {
      date: txn.transactionDate,
      type,
      category: categoryLabel(txn),
      reference: txn.referenceNumber || (txn.referenceId ? String(txn.referenceId) : "—"),
      description: txn.reason || txn.remarks || categoryLabel(txn),
      quantity: qty,
      balance: 0,
      batches: txn.batch
        ? [{ batchNumber: txn.batch.batchNumber, quantity: qty }]
        : [],
      details: {
        transactionNumber: txn.transactionNumber,
        referenceType: txn.referenceType,
        referenceId: txn.referenceId,
        metadata: txn.metadata,
      },
    };
  });

  const totalCredit = ledgerEntries
    .filter((e) => e.type === "CREDIT")
    .reduce((s, e) => s + e.quantity, 0);
  const totalDebit = ledgerEntries
    .filter((e) => e.type === "DEBIT")
    .reduce((s, e) => s + e.quantity, 0);
  const closingStock = parseNum(product.currentStock);
  const openingStock = closingStock - totalCredit + totalDebit;

  let running = openingStock;
  const withBalance = ledgerEntries.map((entry) => {
    if (entry.type === "CREDIT") running += entry.quantity;
    else running -= entry.quantity;
    return { ...entry, balance: running };
  });

  return {
    product: {
      productId: product._id,
      code: product.code,
      name: product.name,
      currentStock: closingStock,
    },
    summary: {
      openingStock,
      totalCredit,
      totalDebit,
      closingStock,
    },
    entries: withBalance.reverse(),
    ledgerSource: "transactions",
  };
}
