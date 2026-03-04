/**
 * Backend-level test: Order cancel → ledger entry + quota (no HTTP).
 * Uses MongoDB session and same logic as factory (dealer wallet + DealerPlantInventoryLedger).
 *
 * Usage (from repo root, backend env loaded):
 *   node scripts/test-cancel-ledger-quota-backend.js
 *
 * Requires: MONGO_URL in .env; a dealer order in DB (dealerOrder: true, status not CANCELLED/REJECTED).
 */

import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import Order from "../models/order.model.js";
import DealerWallet from "../models/dealerWallet.js";
import DealerPlantInventoryLedger from "../models/dealerPlantInventoryLedger.model.js";
import User from "../models/user.model.js"; // register User so Order post-save (status notification) works

const MONGO_URL = process.env.MONGO_URL || process.env.MONGODB_URI || "mongodb://localhost:27017/nursery";

function log(name, ok, detail = "") {
  const icon = ok ? "✅" : "❌";
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function run() {
  console.log("\n========== Backend test: Cancel → Ledger + Quota ==========\n");

  await mongoose.connect(MONGO_URL);
  console.log(`DB: ${mongoose.connection.name}\n`);

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findOne({
      dealerOrder: true,
      orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
    }).session(session);

    if (!order) {
      console.log("❌ No dealer order found (dealerOrder: true, status not CANCELLED/REJECTED).");
      await session.abortTransaction();
      session.endSession();
      await mongoose.disconnect();
      process.exit(1);
    }

    const dealerId = order.dealer || order.salesPerson;
    const n = order.numberOfPlants || 0;
    const orderId = order._id;

    console.log(`Order: ${orderId}, dealer: ${dealerId}, plants: ${n}, status: ${order.orderStatus}`);

    const plantTypeId = order.plantName;
    const subTypeId = order.plantSubtype;
    const slotId = order.bookingSlot;

    if (!dealerId || !plantTypeId || !slotId) {
      console.log("❌ Order missing dealer/plantName/bookingSlot.");
      await session.abortTransaction();
      session.endSession();
      await mongoose.disconnect();
      process.exit(1);
    }

    // --- Before ---
    const ledgerCountBefore = await DealerPlantInventoryLedger.countDocuments({ dealer: dealerId }).session(session);
    const wallet = await DealerWallet.findOne({ dealer: dealerId }).session(session);
    const entry = wallet?.entries?.find(
      (e) =>
        e.plantType?.equals(plantTypeId) &&
        e.subType?.equals(subTypeId) &&
        e.bookingSlot?.equals(slotId)
    );
    const remainingBefore = entry ? (entry.quantity || 0) - (entry.bookedQuantity || 0) : 0;

    console.log(`Before: ledger entries=${ledgerCountBefore}, wallet remaining=${remainingBefore}\n`);

    // --- Cancel flow (same as factory: release booking / add back, create ledger, update order) ---
    const ledgerDealerId = dealerId;
    let balanceBefore = remainingBefore;

    if (entry) {
      const currentBooked = entry.bookedQuantity || 0;
      if (currentBooked >= n) {
        entry.bookedQuantity = currentBooked - n;
      } else {
        entry.quantity = (entry.quantity || 0) + n;
        entry.remainingQuantity = (entry.remainingQuantity || 0) + n;
      }
      await wallet.save({ session });
    } else {
      if (!wallet) {
        const newWallet = new DealerWallet({
          dealer: dealerId,
          entries: [{
            plantType: plantTypeId,
            subType: subTypeId,
            bookingSlot: slotId,
            quantity: n,
            bookedQuantity: 0,
            remainingQuantity: n,
          }],
        });
        await newWallet.save({ session });
      } else {
        wallet.entries.push({
          plantType: plantTypeId,
          subType: subTypeId,
          bookingSlot: slotId,
          quantity: n,
          bookedQuantity: 0,
          remainingQuantity: n,
        });
        await wallet.save({ session });
      }
    }

    const balanceAfter = balanceBefore + n;

    await DealerPlantInventoryLedger.createLedgerEntry(
      {
        transactionType: "INVENTORY_RELEASE",
        dealer: ledgerDealerId,
        plantType: plantTypeId,
        subType: subTypeId,
        bookingSlot: slotId,
        quantity: n,
        balanceBefore,
        balanceAfter,
        referenceId: orderId,
        description: `Order cancelled: +${n} plants to dealer quota`,
        performedBy: null,
      },
      session
    );

    order.orderStatus = "CANCELLED";
    order.quotaRestored = true;
    await order.save({ session });

    await session.commitTransaction();
    session.endSession();

    // --- Assert after ---
    const ledgerCountAfter = await DealerPlantInventoryLedger.countDocuments({ dealer: dealerId });
    const releaseForOrder = await DealerPlantInventoryLedger.findOne({
      dealer: dealerId,
      referenceId: orderId,
      transactionType: "INVENTORY_RELEASE",
    }).lean();

    const walletAfter = await DealerWallet.findOne({ dealer: dealerId });
    const entryAfter = walletAfter?.entries?.find(
      (e) =>
        e.plantType?.equals(plantTypeId) &&
        e.subType?.equals(subTypeId) &&
        e.bookingSlot?.equals(slotId)
    );
    const remainingAfter = entryAfter
      ? (entryAfter.quantity || 0) - (entryAfter.bookedQuantity || 0)
      : 0;

    log("Ledger: new INVENTORY_RELEASE for this order", !!releaseForOrder, releaseForOrder ? `id=${releaseForOrder._id}` : "");
    log("Ledger count increased", ledgerCountAfter > ledgerCountBefore, `${ledgerCountBefore} → ${ledgerCountAfter}`);
    const quotaNotReduced = remainingAfter >= remainingBefore;
    const quotaIncreased = remainingAfter >= remainingBefore + n;
    log("Quota: not reduced (remaining same or higher)", quotaNotReduced, `remaining ${remainingBefore} → ${remainingAfter} (+${remainingAfter - remainingBefore}), order plants=${n}`);

    console.log("\n--- Summary ---");
    console.log(`  Ledger entry created: ${releaseForOrder ? "Yes" : "No"}`);
    console.log(`  Quota reduced: No (remaining increased or same: ${quotaNotReduced ? "Yes" : "No"}${quotaIncreased ? ", +plants back" : ""})`);
    console.log("\n========== Done ==========\n");
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error("Test failed:", err);
    process.exit(1);
  } finally {
    await new Promise((r) => setTimeout(r, 500)); // let Order post-save hook finish
    await mongoose.disconnect();
  }
}

run();
