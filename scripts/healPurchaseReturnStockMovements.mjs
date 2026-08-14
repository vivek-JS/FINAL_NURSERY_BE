/**
 * Backfill Ram Agri stock movements for completed purchase returns missing ledger rows.
 * NODE_ENV=production node scripts/healPurchaseReturnStockMovements.mjs
 */
import "dotenv/config";
import mongoose from "mongoose";
import PurchaseReturn from "../models/purchaseReturn.model.js";
import RamAgriStockMovement from "../models/ramAgriStockMovement.model.js";
import {
  RAM_AGRI_MOVEMENT_TYPES,
  safeAppendRamAgriStockMovements,
} from "../services/ramAgriStockMovement.service.js";

const uri =
  process.env.NODE_ENV === "production"
    ? process.env.PROD_MONGO_URL || process.env.MONGO_URL
    : process.env.MONGO_URL || process.env.STAGE_MONGO_URL;

await mongoose.connect(uri);
const stats = { scanned: 0, created: 0, skipped: 0, errors: [] };

const prs = await PurchaseReturn.find({ status: "COMPLETED" }).lean();
for (const pr of prs) {
  stats.scanned += 1;
  try {
    const agriLines = (pr.lines || []).filter((l) => l.isRamAgriProduct);
    if (!agriLines.length) {
      stats.skipped += 1;
      continue;
    }
    const exists = await RamAgriStockMovement.exists({
      referenceType: "PurchaseReturn",
      $or: [{ referenceId: pr._id }, { referenceNumber: pr.returnNumber }],
      movementType: RAM_AGRI_MOVEMENT_TYPES.PURCHASE_RETURN_OUT,
    });
    if (exists) {
      stats.skipped += 1;
      continue;
    }
    for (const line of agriLines) {
      if (!(Number(line.returnQuantity) > 0)) continue;
      if (!line.ramAgriCropId || !line.ramAgriVarietyId) continue;
      await safeAppendRamAgriStockMovements({
        cropId: line.ramAgriCropId,
        varietyId: line.ramAgriVarietyId,
        movementType: RAM_AGRI_MOVEMENT_TYPES.PURCHASE_RETURN_OUT,
        batchRows: [
          {
            batchId: line.batch,
            batchNumber: line.batchNumber,
            quantity: line.returnQuantity,
          },
        ],
        referenceType: "PurchaseReturn",
        referenceId: pr._id,
        referenceNumber: pr.returnNumber,
        description: `Backfill purchase return ${pr.returnNumber}`,
        performedBy: pr.createdBy,
        performedAt: pr.returnedAt || pr.createdAt,
        metadata: { backfill: true },
      });
      stats.created += 1;
    }
  } catch (e) {
    stats.errors.push(`${pr.returnNumber}: ${e.message}`);
  }
}

console.log(JSON.stringify(stats, null, 2));
await mongoose.disconnect();
