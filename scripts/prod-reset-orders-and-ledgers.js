import dotenv from "dotenv";
import mongoose from "mongoose";

import Order from "../models/order.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import DealerOrder from "../models/dealerOrder.model.js";
import SellOrder from "../models/sellOrder.model.js";
import PurchaseOrder from "../models/purchaseOrder.model.js";
import ErrorfulOrder from "../models/errorfulOrder.model.js";

import Payment from "../models/payment.model.js";
import BulkPayment from "../models/bulkPayment.model.js";
import PaymentActivity from "../models/paymentActivity.model.js";

import FarmerPlantOrderLedgerEntry from "../models/farmerPlantOrderLedger.model.js";
import DealerLedgerEntry from "../models/dealerLedgerEntry.model.js";
import DealerPlantInventoryLedger from "../models/dealerPlantInventoryLedger.model.js";
import RamAgriCustomerLedgerEntry from "../models/ramAgriCustomerLedger.model.js";
import FarmerPlantOrderArchive from "../models/farmerPlantOrderArchive.model.js";

import DealerBooking from "../models/dealerBooking.model.js";
import DealerWallet from "../models/dealerWallet.js";

import Sowing from "../models/sowing.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import InventoryOutward from "../models/inventoryOutward.model.js";
import SlotTransferLog from "../models/slotTransfer.model.js";
import InventoryTransaction from "../models/inventoryTransaction.model.js";

import PlantSlot from "../models/slots.model.js";
import PlantProductMapping from "../models/plantProductMapping.model.js";

dotenv.config();

const args = process.argv.slice(2);
const hasArg = (name) => args.includes(name);

const dryRun = hasArg("--dry-run");
const execute = hasArg("--execute");
const yes = hasArg("--yes");
const prodDb = hasArg("--prod-db");

if (execute && !yes) {
  console.error("Refusing to execute destructive operations. Add `--yes`.");
  process.exit(1);
}

if (execute && !prodDb) {
  console.error("Refusing to execute destructive operations without `--prod-db`.");
  process.exit(1);
}

const modeLabel = dryRun ? "DRY RUN" : execute ? "EXECUTE" : "NO-OP";
if (modeLabel === "NO-OP") {
  console.error("Pass either `--dry-run` or (`--execute --yes --prod-db`).");
  process.exit(1);
}

const mongoUrl = prodDb ? process.env.PROD_MONGO_URL : process.env.MONGO_URL;
if (!mongoUrl) {
  console.error(`Missing mongo url. Set ${prodDb ? "PROD_MONGO_URL" : "MONGO_URL"} in env.`);
  process.exit(1);
}

const logDbConnection = () => {
  const { name, host, port } = mongoose.connection;
  console.log(`DB: ${name}@${host}:${port}`);
};

const deleteModel = async (Model, strategy = "mongoose") => {
  if (strategy === "native") return Model.collection.deleteMany({});
  return Model.deleteMany({});
};

const safeNumber = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const computeAvailablePlantsNoBookings = (slot) => {
  const total = safeNumber(slot.totalPlants, 0);
  const bufferAdjusted = safeNumber(slot.bufferAdjustedCapacity, 0);
  const bufferAmount = safeNumber(slot.bufferAmount, 0);

  // Prefer already computed capacity-after-buffer. Fallback to total-bufferAmount or total.
  let value = total;
  if (bufferAdjusted > 0) value = bufferAdjusted;
  else if (bufferAmount > 0) value = total - bufferAmount;

  return Math.max(0, safeNumber(value, total));
};

const resetPlantSlotBookingState = async ({ Model, dryRunMode }) => {
  const totalPlantSlots = await Model.estimatedDocumentCount();
  console.log(`\nPlantSlot reset: ${totalPlantSlots} PlantSlot document(s) to update`);

  if (dryRunMode) {
    console.log("DRY RUN: Skipping PlantSlot nested booking reset.");
    return;
  }

  const cursor = Model.find({}, { subtypeSlots: 1 }).lean().cursor();
  const bulk = [];
  const bulkBatchSize = 50;
  let processed = 0;

  console.log("Resetting PlantSlot booking state (nested)...");
  for await (const doc of cursor) {
    const subtypes = Array.isArray(doc.subtypeSlots) ? doc.subtypeSlots : [];

    for (const subtypeSlot of subtypes) {
      const slots = Array.isArray(subtypeSlot.slots) ? subtypeSlot.slots : [];
      for (const slot of slots) {
        // Booking references
        slot.orders = [];

        // Sowing/booking quantities
        slot.primarySowed = 0;
        slot.officeSowed = 0;
        slot.plantsSowed = 0;
        slot.totalBookedPlants = 0;

        // Reset sowing state (so UI doesn't show a partial sowing)
        slot.sowingDate = null;
        slot.plantReadyDate = null;
        slot.sowingCompleted = false;
        slot.sowingCompletedDate = null;
        slot.sowingInProgress = [];
        slot.linkedSowingRequests = [];

        // Reset gap coverage tracking
        slot.gapCovered = [];
        slot.gapFullyCovered = false;

        // Reset excessive sowing
        slot.excessiveSowing = { packets: 0, plants: 0 };

        // Reset slot audit trail state
        slot.slotTrail = [];

        // Reset ready-plants order booking state (keep available/received)
        if (Array.isArray(slot.productStock)) {
          slot.productStock = slot.productStock.map((ps) => ({
            ...ps,
            booked: 0,
          }));
        }

        // Restore availability to “no bookings” state.
        slot.availablePlants = computeAvailablePlantsNoBookings(slot);

        // Clear capacity overflow flags.
        slot.isOverflow = false;
        slot.overflow = false;
      }
    }

    bulk.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { subtypeSlots: subtypes } },
      },
    });

    processed += 1;
    if (bulk.length >= bulkBatchSize) {
      await Model.bulkWrite(bulk, { ordered: false });
      console.log(`  PlantSlot bulk updated: ${processed}/${totalPlantSlots}`);
      bulk.length = 0;
    }
  }

  if (bulk.length > 0) {
    await Model.bulkWrite(bulk, { ordered: false });
  }

  console.log(`PlantSlot reset completed for ${processed} document(s).`);
};

async function resetPlantProductMapping({ dryRunMode }) {
  const total = await PlantProductMapping.estimatedDocumentCount();
  console.log(`\nPlantProductMapping reset: ${total} document(s)`);
  if (dryRunMode) {
    console.log("DRY RUN: Skipping PlantProductMapping slotReferences/allocatedQuantity reset.");
    return;
  }

  await PlantProductMapping.updateMany(
    {},
    { $set: { slotReferences: [], allocatedQuantity: 0 } }
  );
  console.log("PlantProductMapping reset completed.");
}

const main = async () => {
  await mongoose.connect(mongoUrl, {
    serverSelectionTimeoutMS: 20_000,
    dbName: undefined,
  });
  logDbConnection();

  const deletionPlans = [
    { label: "Orders - Farmer Order", model: Order, strategy: "mongoose" },
    { label: "Orders - Agri Sales Order", model: AgriSalesOrder, strategy: "mongoose" },
    { label: "Orders - Dealer Order", model: DealerOrder, strategy: "mongoose" },
    { label: "Orders - Sell Order", model: SellOrder, strategy: "mongoose" },
    { label: "Orders - Purchase Order", model: PurchaseOrder, strategy: "mongoose" },
    { label: "Orders - Errorful Order", model: ErrorfulOrder, strategy: "mongoose" },

    // Payments
    { label: "Payments - Payment", model: Payment, strategy: "mongoose" },
    { label: "Payments - BulkPayment", model: BulkPayment, strategy: "mongoose" },
    { label: "Payments - PaymentActivity", model: PaymentActivity, strategy: "mongoose" },

    // Ledgers (immutable; use native deletes)
    {
      label: "Ledger - FarmerPlantOrderLedgerEntry",
      model: FarmerPlantOrderLedgerEntry,
      strategy: "native",
    },
    {
      label: "Ledger - DealerLedgerEntry",
      model: DealerLedgerEntry,
      strategy: "native",
    },
    {
      label: "Ledger - DealerPlantInventoryLedger",
      model: DealerPlantInventoryLedger,
      strategy: "native",
    },
    {
      label: "Ledger - RamAgriCustomerLedgerEntry",
      model: RamAgriCustomerLedgerEntry,
      strategy: "native",
    },
    {
      label: "Ledger - FarmerPlantOrderArchive",
      model: FarmerPlantOrderArchive,
      strategy: "native",
    },

    // Dealer-side book/ledger helpers
    { label: "Dealer - DealerBooking", model: DealerBooking, strategy: "mongoose" },
    { label: "Dealer - DealerWallet", model: DealerWallet, strategy: "mongoose" },

    // Slot/workflow state
    { label: "Slot workflow - Sowing", model: Sowing, strategy: "mongoose" },
    { label: "Slot workflow - SowingRequest", model: SowingRequest, strategy: "mongoose" },
    { label: "Slot workflow - InventoryOutward", model: InventoryOutward, strategy: "mongoose" },
    { label: "Slot workflow - SlotTransferLog", model: SlotTransferLog, strategy: "mongoose" },

    // Stock movement history (immutable)
    {
      label: "Inventory - InventoryTransaction (immutable history)",
      model: InventoryTransaction,
      strategy: "native",
    },
  ];

  console.log(`\n=== prod-reset-orders-and-ledgers.js: ${modeLabel} ===`);

  // Pre-flight: show counts
  const counts = [];
  for (const plan of deletionPlans) {
    const count = await plan.model.countDocuments({});
    counts.push({ label: plan.label, count });
  }

  const plantSlotCount = await PlantSlot.estimatedDocumentCount();
  const plantProductMappingCount = await PlantProductMapping.estimatedDocumentCount();

  console.log("\nDocument counts (pre-flight):");
  for (const row of counts) {
    console.log(`  ${row.label}: ${row.count}`);
  }
  console.log(`  PlantSlot: ${plantSlotCount}`);
  console.log(`  PlantProductMapping: ${plantProductMappingCount}`);

  if (dryRun) {
    console.log("\nDRY RUN: No data is modified.");
    console.log("Next step (destructive): run with `--prod-db --execute --yes`.");
    await mongoose.disconnect();
    return;
  }

  console.log("\nExecuting destructive reset...");

  for (const plan of deletionPlans) {
    const label = plan.label;
    const before = counts.find((c) => c.label === label)?.count ?? "unknown";
    console.log(`\nDeleting: ${label}`);
    if (plan.strategy === "native") {
      await deleteModel(plan.model, "native");
    } else {
      await deleteModel(plan.model, "mongoose");
    }

    const afterCount = await plan.model.countDocuments({});
    console.log(`  Deleted ~${before} doc(s); remaining: ${afterCount}`);
  }

  // Reset lot booking state inside PlantSlot (do not delete slot docs)
  await resetPlantSlotBookingState({ Model: PlantSlot, dryRunMode: false });

  // Reset dealer slotReferences inside mappings
  await resetPlantProductMapping({ dryRunMode: false });

  console.log("\nReset completed.");
  await mongoose.disconnect();
};

main().catch(async (e) => {
  console.error("Reset script failed:", e?.message || e);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

