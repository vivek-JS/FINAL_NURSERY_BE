/**
 * Issue-sheet Aug 26 – Sep 2, 2026: batch subtract + ledger LOAD + slot sync fix.
 * Usage:
 *   node scripts/apply-issue-sheet-aug26-sep02.js --dry-run
 *   node scripts/apply-issue-sheet-aug26-sep02.js
 *   node scripts/apply-issue-sheet-aug26-sep02.js --fix-sync-only
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import Order from "../models/order.model.js";
import { recordSecondaryOutwardOnLedger } from "../services/secondaryDispatchAvailability.service.js";
import { recordSecondaryDispatchLedger } from "../services/secondaryDispatchLedgerWorkflow.service.js";
import {
  subtractSecondaryInwardSlotStock,
  syncSecondaryInwardSlotStockAdd,
  computePendingSlotSync,
  computeReadyPositionSubtract,
} from "../services/secondaryShedSlotStock.service.js";
import { computeSecondaryDispatchEligibility } from "../services/secondaryVehicleLoad.service.js";
import moment from "moment";

const DRY_RUN = process.argv.includes("--dry-run");
const FIX_SYNC_ONLY = process.argv.includes("--fix-sync-only");
const DISPATCH_ID = "backfill-issue-sheet-aug26-sep02-2026";
const REMARKS = "issue-sheet-aug26-sep02-2026";
const SOURCE = REMARKS;

/** @type {{ orderId: number, plants: number, batchNumber: string }[]} */
const ROWS = [
  { orderId: 3515, plants: 400, batchNumber: "SB-D-RAJGAD-19" },
  { orderId: 2850, plants: 1830, batchNumber: "SB-D-DEVGIRI-SB-OLD" },
  { orderId: 3362, plants: 1900, batchNumber: "SB-D-DEVGIRI-SB-OLD" },
  { orderId: 3488, plants: 2800, batchNumber: "SB-D-DEVGIRI-SB-OLD" },
  { orderId: 3517, plants: 1000, batchNumber: "SB-D-DEVGIRI-SB-OLD" },
  { orderId: 3131, plants: 4500, batchNumber: "SB-68" },
  { orderId: 3132, plants: 5000, batchNumber: "SB-68" },
  { orderId: 3528, plants: 70, batchNumber: "SB-D-12NOVISH-mix" },
  { orderId: 3541, plants: 4200, batchNumber: "SB-D-DEVGIRI-510" },
  { orderId: 3632, plants: 900, batchNumber: "SB-D-DEVGIRI-510" },
  { orderId: 3633, plants: 3000, batchNumber: "SB-D-SHIVNERI-19" },
  { orderId: 3532, plants: 2400, batchNumber: "VAS-D-RAIGAD-911" },
  { orderId: 3526, plants: 2200, batchNumber: "VAS-D-RAIGAD-911" },
  { orderId: 3365, plants: 3400, batchNumber: "SB-D-SHIVNERI-19" },
  { orderId: 3542, plants: 4, batchNumber: "SB-D-SHIVNERI-19" },
  { orderId: 3543, plants: 312, batchNumber: "SB-D-PRATAPGA-SB-OLD" },
  { orderId: 3547, plants: 300, batchNumber: "SB-D-SHIVNERI-19" },
  { orderId: 3548, plants: 300, batchNumber: "SB-D-SHIVNERI-19" },
  { orderId: 3550, plants: 300, batchNumber: "SB-D-SHIVNERI-19" },
  { orderId: 3551, plants: 250, batchNumber: "SB-D-SHIVNERI-19" },
  { orderId: 3565, plants: 8000, batchNumber: "VAS-D-RAIGAD-911" },
  { orderId: 3389, plants: 3500, batchNumber: "SB-98" },
  { orderId: 3570, plants: 600, batchNumber: "SB-D-PRATAPGA-SB-OLD" },
  { orderId: 3580, plants: 4200, batchNumber: "SB-307" },
  { orderId: 3301, plants: 2800, batchNumber: "SB-307" },
  { orderId: 3577, plants: 346, batchNumber: "SB-98" },
  { orderId: 3578, plants: 48, batchNumber: "SB-98" },
];

function trayMath(plants, cavity = 126) {
  const fullTrays = Math.floor(plants / cavity);
  const partialTrayPlants = plants % cavity;
  const numberOfTrays = partialTrayPlants > 0 ? fullTrays + 1 : Math.max(1, fullTrays);
  return { cavity, fullTrays, partialTrayPlants, numberOfTrays, numberOfBottles: numberOfTrays };
}

const BATCH_FALLBACKS = {
  "SB-D-DEVGIRI-SB-OLD": ["SB-D-DEVGIRI-510", "SB-D-DEVGIRI-19"],
  "SB-D-23NO-CB": ["SB-68", "SB-98", "SB-307"],
  "SB-D-SHIVNERI-19": ["SB-D-RAJGAD-19"],
};

async function resolveBatchContext(batchNumber, session, minPlants = 1) {
  const tryBatches = [batchNumber, ...(BATCH_FALLBACKS[batchNumber] || [])];
  for (const bn of tryBatches) {
    const batchLean = await DispatchBatch.findOne({ batchNumber: bn }).session(session).lean();
    if (!batchLean) continue;
    const po = await PlantOutward.findOne({ batchId: batchLean._id }).session(session);
    if (!po?.secondaryInward?.length) continue;
    const si =
      po.secondaryInward.find((s) => (Number(s.availableQuantity) || 0) >= minPlants) ||
      po.secondaryInward.find((s) => (Number(s.availableQuantity) || 0) > 0) ||
      po.secondaryInward[0];
    if (!si) continue;
    const avail = Number(si.availableQuantity) || 0;
    if (avail >= minPlants) {
      return {
        batchLean,
        po,
        si,
        secondaryInwardId: si._id,
        usedBatchNumber: bn,
      };
    }
  }
  throw new Error(`No batch with avail >= ${minPlants} for ${batchNumber} (tried ${tryBatches.join(", ")})`);
}

async function fixSyncedForLedgerOrder(orderOid, plants, batchNumber, session, results) {
  const linesCol = mongoose.connection.collection("secondarydispatchledgerlines");
  const ledger = await linesCol
    .find({ linkedOrderId: String(orderOid), action: "LOAD", batchNumber })
    .toArray();
  if (!ledger.length) return;
  const qty = ledger.reduce((s, l) => s + (Number(l.plantsAbs) || 0), 0);
  if (qty < 1) return;

  const { batchLean, po, si, secondaryInwardId } = await resolveBatchContext(
    batchNumber,
    session,
    1
  );
  const syncedBefore = Math.max(0, Number(si.slotStockSyncedPlants) || 0);
  const sub = computeReadyPositionSubtract(syncedBefore, qty);
  if (sub.subtracted < 1 || sub.newSynced === syncedBefore) {
    results.push({ step: "sync_ok", orderOid, batchNumber, syncedBefore });
    return;
  }
  if (DRY_RUN) {
    results.push({
      step: "would_fix_sync",
      batchNumber,
      orderOid,
      syncedBefore,
      syncedAfter: sub.newSynced,
      subtracted: sub.subtracted,
    });
    return;
  }
  await PlantOutward.updateOne(
    { batchId: batchLean._id, "secondaryInward._id": secondaryInwardId },
    { $set: { "secondaryInward.$.slotStockSyncedPlants": sub.newSynced } },
    { session }
  );
  results.push({
    step: "fixed_sync",
    batchNumber,
    orderOid,
    syncedBefore,
    syncedAfter: sub.newSynced,
    subtracted: sub.subtracted,
  });
}

async function applyOneRow(row, session, results) {
  const order = await Order.findOne({ orderId: row.orderId }).session(session);
  if (!order) {
    results.push({ step: "skip_no_order", orderId: row.orderId });
    return;
  }
  const orderOid = String(order._id);

  const linesCol = mongoose.connection.collection("secondarydispatchledgerlines");
  const existing = await linesCol
    .find({ linkedOrderId: orderOid, action: "LOAD", batchNumber: row.batchNumber })
    .toArray();
  if (existing.length) {
    await fixSyncedForLedgerOrder(orderOid, row.plants, row.batchNumber, session, results);
    results.push({
      step: "skip_ledger_exists",
      orderId: row.orderId,
      ledgerQty: existing.reduce((s, l) => s + l.plantsAbs, 0),
    });
    return;
  }

  if (FIX_SYNC_ONLY) return;

  const ctx = await resolveBatchContext(row.batchNumber, session, row.plants);
  const { batchLean, po, si, secondaryInwardId, usedBatchNumber } = ctx;
  const effectiveBatch = usedBatchNumber || row.batchNumber;
  const plants = row.plants;
  const availBefore = Number(si.availableQuantity) || 0;
  if (availBefore < plants) {
    throw new Error(
      `${effectiveBatch} order #${row.orderId}: insufficient avail ${availBefore} < ${plants}`
    );
  }

  const siPlain = typeof si.toObject === "function" ? si.toObject() : si;
  const pollyhouse = String(siPlain.pollyhouse || "").trim();
  const { cavity, fullTrays, partialTrayPlants, numberOfTrays, numberOfBottles } = trayMath(
    plants,
    Number(siPlain.cavity) || 126
  );
  const now = new Date();

  const secondaryDays = Number(batchLean.secondaryPlantReadyDays) || 0;
  const dispatchElig = computeSecondaryDispatchEligibility(
    siPlain,
    secondaryDays,
    moment().startOf("day")
  );

  let syncedForSubtract = Math.max(0, Number(siPlain.slotStockSyncedPlants) || 0);
  if (!DRY_RUN) {
    try {
      const syncResult = await syncSecondaryInwardSlotStockAdd({
        session,
        batchId: batchLean._id,
        secondaryInwardId,
        batchLean,
        siPlain,
        dispatchEligible: dispatchElig.dispatchEligible,
        force: true,
        readyPositionOnly: true,
        performedBy: null,
      });
      syncedForSubtract += syncResult?.applied ?? 0;
    } catch (e) {
      console.warn("[issue-sheet] sync warn:", e?.message);
    }
  } else {
    const pending = computePendingSlotSync(availBefore, syncedForSubtract);
    syncedForSubtract += pending;
  }

  const syncSub = computeReadyPositionSubtract(syncedForSubtract, plants);
  const newSynced = syncSub.newSynced;
  const availAfter = availBefore - plants;

  if (DRY_RUN) {
    results.push({
      step: "would_subtract",
      orderId: row.orderId,
      batch: effectiveBatch,
      plants,
      syncedBefore: Number(siPlain.slotStockSyncedPlants) || 0,
      syncedAfter: newSynced,
      fallback: effectiveBatch !== row.batchNumber ? row.batchNumber : undefined,
    });
    return;
  }

  po.validateTransfer("secondaryInward", secondaryInwardId, plants);

  const secondaryOutwardEntry = {
    secondaryOutwardDate: now,
    numberOfBottles,
    size: siPlain.size || "R1",
    cavity,
    numberOfTrays,
    numberOfFullTrays: fullTrays,
    partialTrayPlants,
    totalQuantity: plants,
    numberOfPlants: plants,
    availableQuantity: plants,
    pollyhouse,
    laboursEngaged: 1,
    transferStatus: "available",
    transferHistory: [
      {
        transferDate: now,
        quantityTransferred: plants,
        remarks: `${REMARKS} office dispatch backfill`,
      },
    ],
    sourceSecondaryInwardId: secondaryInwardId,
    stockSource: "SECONDARY_INWARD",
    linkedOrderId: order._id,
  };

  const newInwardStatus = availAfter === 0 ? "fully_transferred" : "partially_transferred";

  const updatedDoc = await PlantOutward.findOneAndUpdate(
    { batchId: batchLean._id, "secondaryInward._id": secondaryInwardId },
    {
      $push: { secondaryOutward: secondaryOutwardEntry },
      $set: {
        "secondaryInward.$.transferStatus": newInwardStatus,
        "secondaryInward.$.availableQuantity": availAfter,
        "secondaryInward.$.slotStockSyncedPlants": newSynced,
      },
    },
    { new: true, session, runValidators: true }
  );

  const outArr = updatedDoc?.secondaryOutward || [];
  const newSo = outArr[outArr.length - 1];
  if (!newSo?._id) throw new Error("Failed to resolve secondaryOutward id");

  try {
    const siForSubtract = {
      ...siPlain,
      availableQuantity: availAfter,
      slotStockSyncedPlants: newSynced,
    };
    await subtractSecondaryInwardSlotStock({
      session,
      batchId: batchLean._id,
      secondaryInwardId,
      batchLean,
      siPlain: siForSubtract,
      quantity: plants,
      performedBy: null,
    });
  } catch (slotErr) {
    console.warn("[issue-sheet] slot subtract warn:", slotErr?.message || slotErr);
  }

  await recordSecondaryOutwardOnLedger(session, {
    dispatchBatchId: batchLean._id,
    plantOutwardId: updatedDoc._id,
    secondaryInwardId,
    secondaryOutwardId: newSo._id,
    quantity: plants,
    performedBy: null,
    metadata: {
      orderId: order._id,
      orderNumber: order.orderId,
      source: SOURCE,
    },
  });

  const ledgerResult = await recordSecondaryDispatchLedger({
    action: "LOAD",
    dispatchId: DISPATCH_ID,
    requestPayload: {
      source: SOURCE,
      orderNumber: order.orderId,
      cmsBatch: effectiveBatch,
      sheetBatch: row.batchNumber,
      plants,
    },
    resolvedAllocations: [
      {
        dispatchId: DISPATCH_ID,
        linkedOrderId: orderOid,
        batchId: String(batchLean._id),
        batchNumber: effectiveBatch,
        secondaryInwardId: String(secondaryInwardId),
        secondaryOutwardId: String(newSo._id),
        linkedBookingSlotId: siPlain.linkedBookingSlotId
          ? String(siPlain.linkedBookingSlotId)
          : null,
        plantRowIndex: 0,
        cavity,
        size: siPlain.size || "R1",
        pollyhouse,
        remarks: REMARKS,
        plants,
        action: "LOAD",
      },
    ],
    linkedOrderId: orderOid,
    plantRowIndex: 0,
    remarks: REMARKS,
    session,
  });

  results.push({
    step: "subtracted",
    orderId: row.orderId,
    batch: effectiveBatch,
    sheetBatch: row.batchNumber !== effectiveBatch ? row.batchNumber : undefined,
    plants,
    syncedAfter: newSynced,
    secondaryOutwardId: String(newSo._id),
    ledgerLines: ledgerResult.lines?.length,
  });
}

async function main() {
  await mongoose.connect(process.env.MONGO_URL || process.env.MONGODB_URI);
  console.log(
    FIX_SYNC_ONLY ? "FIX SYNC ONLY" : DRY_RUN ? "DRY RUN" : "EXECUTE",
    "- issue sheet aug26-sep02"
  );
  const results = [];
  for (const row of ROWS) {
    if (DRY_RUN) {
      try {
        await applyOneRow(row, null, results);
      } catch (err) {
        results.push({
          step: "failed",
          orderId: row.orderId,
          batch: row.batchNumber,
          plants: row.plants,
          error: err?.message || String(err),
        });
      }
      continue;
    }
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await applyOneRow(row, session, results);
      });
    } catch (err) {
      results.push({
        step: "failed",
        orderId: row.orderId,
        batch: row.batchNumber,
        plants: row.plants,
        error: err?.message || String(err),
      });
    } finally {
      await session.endSession();
    }
  }
  const subtracted = results.filter((r) => r.step === "subtracted").length;
  const skipped = results.filter((r) => r.step === "skip_ledger_exists").length;
  const fixed = results.filter((r) => r.step === "fixed_sync").length;
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: DRY_RUN,
        fixSyncOnly: FIX_SYNC_ONLY,
        subtracted,
        skipped,
        fixedSync: fixed,
        results,
      },
      null,
      2
    )
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
