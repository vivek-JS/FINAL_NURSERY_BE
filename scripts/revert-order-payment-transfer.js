/**
 * Revert an accidental order payment transfer in MongoDB (uses same undo logic as API).
 *
 * Usage (from FINAL_NURSERY_BE with MONGO_URL in .env):
 *   node scripts/revert-order-payment-transfer.js --target-order 1955
 *   node scripts/revert-order-payment-transfer.js --target-order 1955 --payment-id <mongoPaymentId> --execute
 *   node scripts/revert-order-payment-transfer.js --target-order 1955 --prod --execute
 *
 * Options:
 *   --target-order <business orderId>   Target order that received the transfer (required)
 *   --payment-id <mongo id>             Specific payment subdoc (if multiple transfers in)
 *   --execute                           Apply changes (default is dry-run preview only)
 *   --prod                              Use PROD_MONGO_URL instead of MONGO_URL
 *   --performed-by <user mongo id>      Audit user id for ledger/history (optional)
 */
import "dotenv/config";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import FarmerOrderTransferRequest from "../models/farmerOrderTransferRequest.model.js";
import {
  isDirectOrderPaymentTransfer,
  isBlockedTransferRequestReCollect,
  undoDirectOrderPaymentTransfer,
  undoApprovedTransferRequestPayment,
} from "../utils/farmerPlantOrderLedgerHelper.js";

function parseArgs(argv) {
  const opts = {
    targetOrder: null,
    paymentId: null,
    execute: false,
    prod: false,
    performedBy: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") opts.execute = true;
    else if (a === "--prod") opts.prod = true;
    else if (a === "--target-order") opts.targetOrder = argv[++i];
    else if (a === "--payment-id") opts.paymentId = argv[++i];
    else if (a === "--performed-by") opts.performedBy = argv[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

function findTransferInPayments(order) {
  return (order.payment || []).filter((p) => {
    if (!p) return false;
    if (p.paymentStatus !== "COLLECTED" && p.paymentStatus !== "PENDING") return false;
    if (p.transferRequestId) return true;
    if (isDirectOrderPaymentTransfer(p)) return true;
    if (p.transferredFromOrderId) return true;
    return false;
  });
}

function describePayment(p, order) {
  const parts = [
    `paymentId=${p._id}`,
    `status=${p.paymentStatus}`,
    `amount=₹${Number(p.paidAmount || 0)}`,
  ];
  if (p.transferRequestId) parts.push(`transferRequestId=${p.transferRequestId}`);
  if (p.transferredFromOrderId) parts.push(`fromOrderMongo=${p.transferredFromOrderId}`);
  if (p.remark) parts.push(`remark=${String(p.remark).split("\n")[0].slice(0, 80)}`);
  return parts.join(" | ");
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.targetOrder) {
    console.log(`
Revert order payment transfer (target order = order that received money).

  node scripts/revert-order-payment-transfer.js --target-order <orderId> [--payment-id <id>] [--execute] [--prod]

Examples:
  node scripts/revert-order-payment-transfer.js --target-order 1955
  node scripts/revert-order-payment-transfer.js --target-order 1955 --execute --prod
`);
    process.exit(opts.help ? 0 : 1);
  }

  const mongoUrl = opts.prod ? process.env.PROD_MONGO_URL : process.env.MONGO_URL;
  if (!mongoUrl) {
    console.error(opts.prod ? "Set PROD_MONGO_URL in .env" : "Set MONGO_URL in .env");
    process.exit(1);
  }

  const orderIdNum = Number(opts.targetOrder);
  if (!Number.isFinite(orderIdNum)) {
    console.error("Invalid --target-order (use business order number e.g. 1955)");
    process.exit(1);
  }

  await mongoose.connect(mongoUrl);
  console.log(opts.prod ? "Connected: PROD_MONGO_URL" : "Connected: MONGO_URL");
  console.log("Mode:", opts.execute ? "EXECUTE" : "DRY-RUN (pass --execute to apply)\n");

  const order = await Order.findOne({ orderId: orderIdNum }).lean();
  if (!order) {
    console.error("Target order not found:", orderIdNum);
    await mongoose.disconnect();
    process.exit(1);
  }

  let candidates = findTransferInPayments(order);
  if (opts.paymentId) {
    candidates = candidates.filter((p) => String(p._id) === String(opts.paymentId));
  }

  if (candidates.length === 0) {
    console.log("No active transfer-in payment found on target order", orderIdNum);
    console.log("Payments on order:");
    for (const p of order.payment || []) {
      console.log(" -", describePayment(p, order));
    }
    await mongoose.disconnect();
    process.exit(1);
  }

  if (candidates.length > 1) {
    console.log("Multiple transfer payments — pick one with --payment-id:\n");
    candidates.forEach((p, i) => console.log(`  [${i + 1}] ${describePayment(p, order)}`));
    await mongoose.disconnect();
    process.exit(1);
  }

  const pay = candidates[0];
  const transferReq = pay.transferRequestId
    ? await FarmerOrderTransferRequest.findById(pay.transferRequestId).lean()
    : null;

  if (isBlockedTransferRequestReCollect(pay, transferReq)) {
    console.log("This transfer appears already undone (target REJECTED / request REJECTED).");
    console.log(describePayment(pay, order));
    await mongoose.disconnect();
    process.exit(0);
  }

  const isDirect = isDirectOrderPaymentTransfer(pay);
  const isRequest = Boolean(pay.transferRequestId && transferReq?.status === "APPROVED");

  console.log("Target order:", orderIdNum, `(mongo ${order._id})`);
  console.log("Payment:", describePayment(pay, order));
  console.log(
    "Revert type:",
    isRequest ? "transfer-request undo" : isDirect ? "direct transfer undo" : "unknown"
  );

  if (!isRequest && !isDirect) {
    console.error(
      "\nCannot auto-revert: payment is not an approved transfer-request or direct transfer."
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!opts.execute) {
    console.log("\nDry-run only. Re-run with --execute to:");
    if (isRequest) {
      console.log("  - Restore source order payment amount(s)");
      console.log("  - Mark target payment REJECTED");
      console.log("  - Mark transfer request REJECTED");
      console.log("  - Post ledger undo (if deployed code includes ledger service)");
    } else {
      console.log("  - Restore source payment to COLLECTED");
      console.log("  - Mark target payment REJECTED");
    }
    console.log("\nOr use ERP/API: PATCH /api/v1/order/updatePaymentStatus");
    console.log(
      JSON.stringify(
        {
          orderId: orderIdNum,
          paymentId: String(pay._id),
          paymentStatus: "REJECTED",
        },
        null,
        2
      )
    );
    await mongoose.disconnect();
    return;
  }

  const targetOrderDoc = await Order.findById(order._id);
  const targetPayment = targetOrderDoc.payment.id(pay._id);
  const userId = opts.performedBy || null;
  const remark = "Reverted via scripts/revert-order-payment-transfer.js";

  try {
    let result;
    if (isRequest) {
      result = await undoApprovedTransferRequestPayment({
        targetOrder: targetOrderDoc,
        targetPayment,
        userId,
        remark,
      });
      console.log("\nOK — transfer request undone");
      console.log("Restored amount:", result.restoredAmount);
      console.log("Source order:", result.sourceOrder?.orderId);
      console.log("Target order:", result.targetOrder?.orderId);
    } else {
      result = await undoDirectOrderPaymentTransfer({
        targetOrder: targetOrderDoc,
        targetPayment,
        userId,
        remark,
      });
      console.log("\nOK — direct transfer undone");
      console.log("Source order:", result.sourceOrder?.orderId);
      console.log("Target order:", result.targetOrder?.orderId);
      console.log("transferId:", result.transferId);
    }
  } catch (e) {
    console.error("\nRevert failed:", e.message || e);
    if (e.statusCode) console.error("statusCode:", e.statusCode);
    await mongoose.disconnect();
    process.exit(1);
  }

  await mongoose.disconnect();
  console.log("\nDone. Do NOT set the same payment to COLLECTED again — create a new transfer if needed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
