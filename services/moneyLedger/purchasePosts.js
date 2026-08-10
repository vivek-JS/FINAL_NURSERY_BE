import mongoose from "mongoose";
import { postEntry, getPartyBalance, roundMoney } from "./postEntry.js";
import Supplier from "../../models/supplier.model.js";
import Merchant from "../../models/merchant.model.js";
import PurchaseOrder from "../../models/purchaseOrder.model.js";

function lineAmount(item) {
  const accepted = Number(item.acceptedQuantity ?? item.quantity) || 0;
  const rate = Number(item.rate) || 0;
  const amount = Number(item.amount);
  if (Number.isFinite(amount) && amount > 0 && accepted > 0) {
    // Prefer proportional if amount was for ordered qty
    return roundMoney(amount);
  }
  return roundMoney(accepted * rate);
}

async function resolveApParty(supplierId) {
  if (!supplierId || !mongoose.isValidObjectId(supplierId)) return null;
  const id = String(supplierId);
  const supplier = await Supplier.findById(id).select("name").lean();
  if (supplier) {
    return { partyType: "SUPPLIER", partyId: supplier._id, partyName: supplier.name || "" };
  }
  const merchant = await Merchant.findById(id).select("name").lean();
  if (merchant) {
    return { partyType: "MERCHANT", partyId: merchant._id, partyName: merchant.name || "" };
  }
  return { partyType: "SUPPLIER", partyId: id, partyName: "" };
}

export async function syncSupplierOutstanding(partyType, partyId) {
  if (!partyId) return;
  const biotech = await getPartyBalance({
    book: "BIOTECH",
    side: "AP",
    partyType,
    partyId,
  });
  const agri = await getPartyBalance({
    book: "RAM_AGRI",
    side: "AP",
    partyType,
    partyId,
  });
  const outstanding = roundMoney(biotech.balance + agri.balance);
  if (partyType === "SUPPLIER") {
    await Supplier.findByIdAndUpdate(partyId, { outstandingAmount: outstanding });
  } else if (partyType === "MERCHANT") {
    await Merchant.findByIdAndUpdate(partyId, { outstandingAmount: outstanding });
  }
}

/**
 * After GRN approve: post PURCHASE credits split by biotech vs ram agri lines.
 */
export async function postPurchaseFromGrn(grn, userId) {
  if (!grn || String(grn.status || "").toLowerCase() !== "approved") {
    return { ok: false, error: "GRN must be approved", status: 400 };
  }

  const supplierId = grn.supplier?._id || grn.supplier;
  const party = await resolveApParty(supplierId);
  if (!party) return { ok: false, error: "GRN has no supplier", status: 400 };

  let classicTotal = 0;
  let agriTotal = 0;
  const classicLines = [];
  const agriLines = [];
  for (const item of grn.items || []) {
    if (!(Number(item.acceptedQuantity) > 0)) continue;
    const amt = lineAmount(item);
    const qty = Number(item.acceptedQuantity) || 0;
    const productLabel =
      item.productName ||
      item.ramAgriVarietyName ||
      item.ramAgriCropName ||
      (item.product?.name ? String(item.product.name) : "") ||
      item.batchNumber ||
      "Item";
    const lineMeta = {
      productName: productLabel,
      batchNumber: item.batchNumber || "",
      qty,
      rate: Number(item.rate) || 0,
      amount: amt,
      crop: item.ramAgriCropName || "",
      variety: item.ramAgriVarietyName || "",
    };
    if (item.isRamAgriProduct) {
      agriTotal = roundMoney(agriTotal + amt);
      agriLines.push(lineMeta);
    } else {
      classicTotal = roundMoney(classicTotal + amt);
      classicLines.push(lineMeta);
    }
  }

  const results = [];
  const poId = grn.purchaseOrder?._id || grn.purchaseOrder;
  let poNumber = "";
  let poDate = null;
  if (poId) {
    const po = await PurchaseOrder.findById(poId).select("poNumber poDate").lean();
    poNumber = po?.poNumber || "";
    poDate = po?.poDate || null;
  }

  /** Prefer business date: GRN date → QC date → linked PO date (back-dated safe) */
  const entryDate = grn.grnDate || grn.qualityCheckDate || poDate || grn.createdAt || new Date();

  if (classicTotal > 0) {
    const r = await postEntry({
      book: "BIOTECH",
      side: "AP",
      partyType: party.partyType,
      partyId: party.partyId,
      partyName: party.partyName,
      entryDate,
      refType: "PURCHASE",
      documentType: "GRN",
      documentId: grn._id,
      documentNumber: grn.grnNumber || "",
      credit: classicTotal,
      description: `Purchase (classic) GRN ${grn.grnNumber || ""} ${poNumber ? `/ ${poNumber}` : ""}`.trim(),
      reference: poNumber || grn.grnNumber || "",
      idempotencyKey: `biotech:ap:grn:${grn._id}:classic`,
      createdBy: userId,
      metadata: {
        purchaseOrderId: poId || null,
        bookSplit: "classic",
        products: classicLines,
      },
    });
    results.push(r);
  }

  if (agriTotal > 0) {
    const r = await postEntry({
      book: "RAM_AGRI",
      side: "AP",
      partyType: party.partyType,
      partyId: party.partyId,
      partyName: party.partyName,
      entryDate,
      refType: "PURCHASE",
      documentType: "GRN",
      documentId: grn._id,
      documentNumber: grn.grnNumber || "",
      credit: agriTotal,
      description: `Purchase (Ram Agri) GRN ${grn.grnNumber || ""} ${poNumber ? `/ ${poNumber}` : ""}`.trim(),
      reference: poNumber || grn.grnNumber || "",
      idempotencyKey: `ram_agri:ap:grn:${grn._id}:agri`,
      createdBy: userId,
      metadata: {
        purchaseOrderId: poId || null,
        bookSplit: "ram_agri",
        products: agriLines,
      },
    });
    results.push(r);
  }

  await syncSupplierOutstanding(party.partyType, party.partyId);
  return { ok: true, results, classicTotal, agriTotal, party };
}

/**
 * Purchase return → AP debit (reduces what we owe).
 */
export async function postPurchaseReturnAp(purchaseReturnDoc, userId) {
  if (!purchaseReturnDoc) return { ok: false, error: "Missing purchase return", status: 400 };
  const amount = roundMoney(purchaseReturnDoc.totalAmount);
  if (amount <= 0) return { ok: true, skipped: true };

  const supplierId =
    purchaseReturnDoc.supplier?._id || purchaseReturnDoc.supplier;
  const party = await resolveApParty(supplierId);
  if (!party) return { ok: false, error: "No supplier on purchase return", status: 400 };

  // Infer book from return lines (classic vs Ram Agri)
  const lines = purchaseReturnDoc.lines || [];
  const agriAmt = roundMoney(
    lines.filter((l) => l.isRamAgriProduct).reduce((s, l) => s + (Number(l.amount) || 0), 0)
  );
  const classicAmt = roundMoney(Math.max(0, amount - agriAmt));
  const results = [];

  async function postBook(book, amt) {
    if (amt <= 0) return null;
    return postEntry({
      book,
      side: "AP",
      partyType: party.partyType,
      partyId: party.partyId,
      partyName: party.partyName,
      entryDate: purchaseReturnDoc.returnedAt || purchaseReturnDoc.createdAt || new Date(),
      refType: "PURCHASE_RETURN",
      documentType: "PurchaseReturn",
      documentId: purchaseReturnDoc._id,
      documentNumber: purchaseReturnDoc.returnNumber || "",
      debit: amt,
      description: `Purchase return ${purchaseReturnDoc.returnNumber || ""} / ${
        purchaseReturnDoc.poNumber || ""
      }`.trim(),
      reference: purchaseReturnDoc.poNumber || purchaseReturnDoc.returnNumber || "",
      idempotencyKey: `${book.toLowerCase()}:ap:purchase_return:${purchaseReturnDoc._id}:${
        book === "RAM_AGRI" ? "agri" : "classic"
      }`,
      createdBy: userId,
      metadata: {
        purchaseOrderId: purchaseReturnDoc.purchaseOrder || null,
        products: lines
          .filter((l) => (book === "RAM_AGRI" ? l.isRamAgriProduct : !l.isRamAgriProduct))
          .map((l) => ({
            productName: l.productName || "",
            batchNumber: l.batchNumber || "",
            qty: Number(l.returnQuantity) || 0,
            rate: Number(l.rate) || 0,
            amount: Number(l.amount) || 0,
          })),
      },
    });
  }

  if (agriAmt > 0) results.push(await postBook("RAM_AGRI", agriAmt));
  if (classicAmt > 0 || agriAmt <= 0) {
    results.push(await postBook("BIOTECH", classicAmt > 0 ? classicAmt : amount));
  }

  await syncSupplierOutstanding(party.partyType, party.partyId);
  return { ok: true, results };
}
