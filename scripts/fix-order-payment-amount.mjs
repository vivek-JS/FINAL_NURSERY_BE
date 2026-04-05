/**
 * Fix a single embedded payment's paidAmount and append a farmer-plant ledger ADJUSTMENT
 * for the delta (ledger lines are immutable).
 *
 * Usage (from FINAL_NURSERY_BE, uses PROD_MONGO_URL or MONGO_URL from .env):
 *   node scripts/fix-order-payment-amount.mjs <numericOrderId> <paymentMongoObjectId> <newPaidAmount>
 *
 * Example:
 *   node scripts/fix-order-payment-amount.mjs 1328 69ca8409966adfbeb8a9ab6e 5000
 */
import "dotenv/config";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import {
  createFarmerPlantLedgerEntry,
  ledgerTransitionExists,
  resolveFarmerIdentity,
} from "../utils/farmerPlantOrderLedgerHelper.js";

const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
if (!uri) {
  console.error("Set PROD_MONGO_URL or MONGO_URL in .env");
  process.exit(1);
}

async function main() {
  const [, , orderIdArg, paymentIdArg, newAmountArg] = process.argv;
  if (!orderIdArg || !paymentIdArg || newAmountArg == null) {
    console.error(
      "Usage: node scripts/fix-order-payment-amount.mjs <orderId> <paymentObjectId> <newPaidAmount>"
    );
    process.exit(1);
  }

  const orderIdNum = Number(orderIdArg);
  const newAmount = Number(newAmountArg);
  if (!Number.isFinite(orderIdNum) || !Number.isFinite(newAmount) || newAmount < 0) {
    console.error("Invalid order id or amount");
    process.exit(1);
  }

  await mongoose.connect(uri);

  const order = await Order.findOne({ orderId: orderIdNum }).populate("farmer");
  if (!order) {
    console.error("Order not found:", orderIdNum);
    process.exit(1);
  }

  const payment = order.payment.id(paymentIdArg);
  if (!payment) {
    console.error("Payment subdocument not found:", paymentIdArg);
    process.exit(1);
  }

  const oldAmount = Number(payment.paidAmount || 0);
  const delta = roundMoney(newAmount - oldAmount);
  if (delta === 0) {
    console.log("No change (already", newAmount, ")");
    await mongoose.disconnect();
    return;
  }

  payment.paidAmount = newAmount;
  payment.updatedAt = new Date();
  order.markModified("payment");
  await order.save();
  console.log("Order saved: payment", oldAmount, "->", newAmount, "; orderPaymentStatus:", order.orderPaymentStatus);

  const transitionKey = `PAYMENT_AMOUNT_CORRECTION_${orderIdNum}_${paymentIdArg}_${oldAmount}_${newAmount}`;
  const exists = await ledgerTransitionExists(order._id, transitionKey);
  if (exists) {
    console.log("Ledger adjustment already present (transitionKey).");
    await mongoose.disconnect();
    return;
  }

  const { customerMobile, customerName, farmerId } = await resolveFarmerIdentity(order);
  if (!customerMobile) {
    console.warn("No farmer mobile; skipping ledger adjustment.");
    await mongoose.disconnect();
    return;
  }

  const debit = delta < 0 ? Math.abs(delta) : 0;
  const credit = delta > 0 ? delta : 0;

  await createFarmerPlantLedgerEntry({
    customerMobile,
    customerName,
    farmerId,
    refType: "ADJUSTMENT",
    refId: payment._id,
    orderId: order._id,
    paymentId: payment._id,
    debit,
    credit,
    reference: String(orderIdNum),
    category: "Payment correction",
    description: `Payment amount correction order ${orderIdNum} ₹${oldAmount} → ₹${newAmount}`,
    entryDate: new Date(),
    metadata: {
      transitionKey,
      paymentId: String(payment._id),
      oldAmount,
      newAmount,
    },
  });

  console.log("Ledger ADJUSTMENT written: debit", debit, "credit", credit);
  await mongoose.disconnect();
}

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
