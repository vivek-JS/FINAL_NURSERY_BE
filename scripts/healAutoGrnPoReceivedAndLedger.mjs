/**
 * Heal Auto GRN POs: receivedQuantity from approved GRNs + missing PURCHASE ledger.
 * Usage: NODE_ENV=production node scripts/healAutoGrnPoReceivedAndLedger.mjs
 */
import "dotenv/config";
import mongoose from "mongoose";
import PurchaseOrder from "../models/purchaseOrder.model.js";
import GRN from "../models/grn.model.js";
import MoneyLedgerEntry from "../models/moneyLedgerEntry.model.js";
import { applyGrnAcceptedQtyToPurchaseOrder } from "../services/grnPoLink.helpers.js";
import { postPurchaseFromGrn } from "../services/moneyLedger/purchasePosts.js";

function resolveMongoUrl() {
  if (process.env.NODE_ENV === "production") {
    return process.env.PROD_MONGO_URL || process.env.MONGO_URL || "";
  }
  return process.env.MONGO_URL || process.env.STAGE_MONGO_URL || "";
}

const uri = resolveMongoUrl();
if (!uri) {
  console.error("No Mongo URI");
  process.exit(1);
}

await mongoose.connect(uri);
console.log("[healAutoGrn] connected");

const stats = { posScanned: 0, posHealedRecv: 0, ledgerPosted: 0, errors: [] };

const pos = await PurchaseOrder.find({
  $or: [{ autoGRN: true }, { status: { $in: ["approved", "partial_received", "received"] } }],
})
  .limit(5000)
  .exec();

for (const po of pos) {
  stats.posScanned += 1;
  try {
    const grns = await GRN.find({
      purchaseOrder: po._id,
      status: { $regex: /^approved$/i },
    });
    if (!grns.length) continue;

    // Reset received from zero then re-apply all approved GRNs (avoid double if partial heal)
    let needsRecvHeal = (po.items || []).some(
      (it) => (Number(it.quantity) || 0) > 0 && !(Number(it.receivedQuantity) > 0)
    );
    // Also heal if status approved but GRN approved with full accept
    if (!needsRecvHeal) {
      const anyRecv = (po.items || []).some((it) => (Number(it.receivedQuantity) || 0) > 0);
      if (!anyRecv && grns.length) needsRecvHeal = true;
    }

    if (needsRecvHeal) {
      for (const it of po.items || []) {
        it.receivedQuantity = 0;
      }
      for (const grn of grns) {
        applyGrnAcceptedQtyToPurchaseOrder(po, grn.items);
      }
      po.markModified("items");
      await po.save({ validateBeforeSave: false });
      stats.posHealedRecv += 1;
      console.log(`healed recv ${po.poNumber} → ${po.status}`);
    }

    for (const grn of grns) {
      const has = await MoneyLedgerEntry.exists({
        documentType: "GRN",
        documentId: grn._id,
        refType: "PURCHASE",
      });
      if (has) continue;
      const r = await postPurchaseFromGrn(grn, po.createdBy || po.approvedBy);
      if (r?.ok && (r.classicTotal > 0 || r.agriTotal > 0)) {
        stats.ledgerPosted += 1;
        console.log(`ledger posted ${grn.grnNumber} classic=${r.classicTotal} agri=${r.agriTotal}`);
      }
    }
  } catch (e) {
    stats.errors.push(`${po.poNumber || po._id}: ${e.message}`);
  }
}

console.log(JSON.stringify(stats, null, 2));
await mongoose.disconnect();
