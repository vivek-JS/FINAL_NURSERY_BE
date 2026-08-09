/**
 * One-time backfill: Ram Agri variety stock movements from historical data.
 *
 * Usage:
 *   node scripts/backfillRamAgriStockMovements.js [--dry-run] [--prod] [--crop=CROP_ID] [--variety=VARIETY_ID]
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import RamAgriBatch from "../models/ramAgriBatch.model.js";
import RamAgriStockMovement from "../models/ramAgriStockMovement.model.js";
import AgriSalesOrder, { getAgriOrderLines } from "../models/agriSalesOrder.model.js";
import GRN from "../models/grn.model.js";
import PurchaseOrder from "../models/purchaseOrder.model.js";
import {
  RAM_AGRI_MOVEMENT_TYPES,
  appendRamAgriStockMovements,
} from "../services/ramAgriStockMovement.service.js";
import { parseTransferAllocFromNotes } from "../services/sowingRamAgriTransfer.service.js";
import Batch from "../models/batch.model.js";

dotenv.config();

const dryRun = process.argv.includes("--dry-run");
const useProd = process.argv.includes("--prod") || process.argv.includes("--prod-db");
const cropFilter = process.argv.find((a) => a.startsWith("--crop="))?.split("=")[1];
const varietyFilter = process.argv.find((a) => a.startsWith("--variety="))?.split("=")[1];

function resolveMongoUri() {
  if (useProd) return process.env.PROD_MONGO_URL || process.env.PROD_MONGODB_URI;
  return (
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URL ||
    process.env.STAGE_MONGO_URL
  );
}

function batchSourceToType(source) {
  if (source === "MANUAL_ADJUSTMENT") return RAM_AGRI_MOVEMENT_TYPES.MANUAL_IN;
  if (source === "SALES_RETURN") return RAM_AGRI_MOVEMENT_TYPES.SALES_RETURN_IN;
  return RAM_AGRI_MOVEMENT_TYPES.GRN_IN;
}

async function backfillFromBatches() {
  const query = {};
  if (cropFilter) query.ramAgriCropId = new mongoose.Types.ObjectId(cropFilter);
  if (varietyFilter) query.ramAgriVarietyId = new mongoose.Types.ObjectId(varietyFilter);

  const batches = await RamAgriBatch.find(query).sort({ receivedDate: 1 }).lean();
  let count = 0;

  for (const batch of batches) {
    const groupKey = `backfill:batch-in:${batch._id}`;
    const exists = await RamAgriStockMovement.findOne({ movementGroupKey: groupKey }).lean();
    if (exists) continue;

    const movementType = batchSourceToType(batch.source);
    const params = {
      cropId: batch.ramAgriCropId,
      varietyId: batch.ramAgriVarietyId,
      movementType,
      batchRows: [
        {
          batchId: batch._id,
          batchNumber: batch.batchNumber,
          quantity: batch.quantity,
        },
      ],
      referenceType: batch.referenceType,
      referenceId: batch.referenceId,
      referenceNumber: batch.referenceNumber,
      description: `Backfill batch receipt — ${batch.batchNumber}`,
      performedBy: batch.createdBy,
      movementGroupKey: groupKey,
      performedAt: batch.receivedDate || batch.createdAt,
    };

    if (!dryRun) await appendRamAgriStockMovements(params);
    count += 1;
  }

  console.log(`Batch IN backfill: ${count} groups${dryRun ? " (dry-run)" : ""}`);
}

async function getLineBatchAllocations(order, lineIndex) {
  if (Array.isArray(order.lineItems) && order.lineItems.length > lineIndex) {
    return order.lineItems[lineIndex].batchAllocations || [];
  }
  if (lineIndex === 0 && Array.isArray(order.batchAllocations)) {
    return order.batchAllocations;
  }
  return [];
}

async function backfillFromDispatchedOrders() {
  const query = { stockDeducted: true };
  const orders = await AgriSalesOrder.find(query).sort({ dispatchedAt: 1 }).lean();
  let outCount = 0;
  let inCount = 0;

  for (const order of orders) {
    const lines = getAgriOrderLines(order);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (!line.ramAgriCropId || !line.ramAgriVarietyId) continue;
      if (cropFilter && String(line.ramAgriCropId) !== String(cropFilter)) continue;
      if (varietyFilter && String(line.ramAgriVarietyId) !== String(varietyFilter)) continue;

      const allocations = await getLineBatchAllocations(order, li);
      const outRows = allocations
        .map((a) => ({
          batchId: a.batchId,
          batchNumber: a.batchNumber,
          quantity: Number(a.quantityDeducted) || 0,
        }))
        .filter((r) => r.quantity > 0);

      if (outRows.length) {
        const outKey = `backfill:order-out:${order._id}:line:${li}`;
        const outExists = await RamAgriStockMovement.findOne({ movementGroupKey: outKey }).lean();
        if (!outExists) {
          const outParams = {
            cropId: line.ramAgriCropId,
            varietyId: line.ramAgriVarietyId,
            movementType: RAM_AGRI_MOVEMENT_TYPES.SALE_DISPATCH_OUT,
            batchRows: outRows,
            referenceType: "AgriSalesOrder",
            referenceId: order._id,
            referenceNumber: order.orderNumber,
            description: `Backfill sale dispatch — ${order.orderNumber || order._id}`,
            performedBy: order.dispatchedBy || order.updatedBy,
            movementGroupKey: outKey,
            performedAt: order.dispatchedAt || order.stockDeductedAt || order.updatedAt,
          };
          if (!dryRun) await appendRamAgriStockMovements(outParams);
          outCount += 1;
        }
      }

      const returnRows = allocations
        .map((a) => ({
          batchId: a.batchId,
          batchNumber: a.batchNumber,
          quantity: Number(a.quantityReturned) || 0,
        }))
        .filter((r) => r.quantity > 0);

      if (returnRows.length) {
        const inKey = `backfill:order-return:${order._id}:line:${li}`;
        const inExists = await RamAgriStockMovement.findOne({ movementGroupKey: inKey }).lean();
        if (!inExists) {
          const movementType = order.stockReturned
            ? RAM_AGRI_MOVEMENT_TYPES.SALES_RETURN_IN
            : RAM_AGRI_MOVEMENT_TYPES.ORDER_CANCEL_RESTORE_IN;
          const inParams = {
            cropId: line.ramAgriCropId,
            varietyId: line.ramAgriVarietyId,
            movementType,
            batchRows: returnRows,
            referenceType: "AgriSalesOrder",
            referenceId: order._id,
            referenceNumber: order.orderNumber,
            description: `Backfill stock restore — ${order.orderNumber || order._id}`,
            performedBy: order.updatedBy,
            movementGroupKey: inKey,
            performedAt: order.stockReturnedAt || order.completedAt || order.updatedAt,
          };
          if (!dryRun) await appendRamAgriStockMovements(inParams);
          inCount += 1;
        }
      }
    }
  }

  console.log(
    `Order backfill: ${outCount} dispatch OUT, ${inCount} restore IN${dryRun ? " (dry-run)" : ""}`
  );
}

async function backfillFromBiotechTransfers() {
  const grns = await GRN.find({ "items.isRamAgriProduct": true }).sort({ grnDate: 1 }).lean();
  let count = 0;

  for (const grn of grns) {
    for (const item of grn.items || []) {
      if (!item.isRamAgriProduct || !item.ramAgriCropId || !item.ramAgriVarietyId) continue;
      if (cropFilter && String(item.ramAgriCropId) !== String(cropFilter)) continue;
      if (varietyFilter && String(item.ramAgriVarietyId) !== String(varietyFilter)) continue;

      let poItem = null;
      if (grn.purchaseOrder && item.poItem) {
        const po = await PurchaseOrder.findById(grn.purchaseOrder).lean();
        poItem =
          po?.items?.find((pi) => String(pi._id) === String(item.poItem)) ||
          po?.items?.find((pi) => pi.isBiotechTransfer);
      }

      if (!poItem?.isBiotechTransfer) continue;

      let batchRows = [];
      if (item.batch) {
        const classicBatch = await Batch.findById(item.batch).select("notes batchNumber").lean();
        const parsed = parseTransferAllocFromNotes(classicBatch?.notes);
        if (parsed?.allocations?.length) {
          batchRows = parsed.allocations.map((a) => ({
            batchId: a.batchId,
            batchNumber: a.batchNumber,
            quantity: Number(a.quantityDeducted) || 0,
          }));
        }
      }

      if (!batchRows.length) {
        batchRows = [
          {
            batchNumber: item.batchNumber || "—",
            quantity: Number(item.acceptedQuantity ?? item.quantity) || 0,
          },
        ];
      }

      batchRows = batchRows.filter((r) => r.quantity > 0);
      if (!batchRows.length) continue;

      const groupKey = `backfill:biotech-out:${grn._id}:${item._id || item.ramAgriVarietyId}`;
      const exists = await RamAgriStockMovement.findOne({ movementGroupKey: groupKey }).lean();
      if (exists) continue;

      const params = {
        cropId: item.ramAgriCropId,
        varietyId: item.ramAgriVarietyId,
        movementType: RAM_AGRI_MOVEMENT_TYPES.SOWING_RAISING_OUT,
        batchRows,
        referenceType: "BiotechTransfer",
        referenceId: grn._id,
        referenceNumber: grn.grnNumber,
        description: `Backfill raising / sowing transfer — GRN ${grn.grnNumber || ""}`,
        performedBy: grn.receivedBy || grn.createdBy,
        movementGroupKey: groupKey,
        performedAt: grn.grnDate || grn.createdAt,
      };

      if (!dryRun) await appendRamAgriStockMovements(params);
      count += 1;
    }
  }

  console.log(`Biotech transfer backfill: ${count} groups${dryRun ? " (dry-run)" : ""}`);
}

async function main() {
  const uri = resolveMongoUri();
  if (!uri) {
    console.error("Mongo URI not configured");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected${dryRun ? " (dry-run)" : ""}${useProd ? " [prod]" : ""}`);

  await backfillFromBatches();
  await backfillFromDispatchedOrders();
  await backfillFromBiotechTransfers();

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
