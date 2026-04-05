/**
 * Mark order payments COLLECTED from Ajay sheet: rows where COLLECTED is TRUE/true.
 *
 * Reads Excel (columns: order_number, COLLECTED, credit_original, …).
 * Finds Order by numeric orderId, picks a PENDING or BANK_VERIFIED payment
 * (prefers amount match to credit_original), sets COLLECTED + remark.
 * Applies dealer wallet credit for bulk dealer orders (non-wallet), same as PATCH flow.
 * Applies farmer plant ledger transition for farmer orders.
 *
 * Usage (from FINAL_NURSERY_BE, prod .env with PROD_MONGO_URL or MONGO_URL):
 *   node scripts/mark-collected-from-advance-match-xlsx.js "/path/to/particulars_match_report_final.xlsx" --dry-run
 *   node scripts/mark-collected-from-advance-match-xlsx.js "/path/to/particulars_match_report_final.xlsx"
 *
 * Env: PROD_MONGO_URL | MONGO_URL | MONGODB_URI | DATABASE
 */
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import DealerWallet from "../models/dealerWallet.js";
import {
  ensureFarmerPlantOrderDebit,
  recordFarmerPlantLedgerPaymentTransition,
} from "../utils/farmerPlantOrderLedgerHelper.js";

dotenv.config();

const REMARK = "advcne matching 5 april from ajay sir sheet";

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseNum(v) {
  if (v == null || v === "") return NaN;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function isCollectedCellTrue(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).trim().toUpperCase();
  return s === "TRUE" || s === "1" || s === "YES";
}

/** Build header name -> 1-based column index from row 1 */
function headerMap(row) {
  const m = {};
  row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const key = String(cell.value ?? "").trim();
    if (key) m[key] = colNumber;
  });
  return m;
}

/** @returns {{ payment: object, mode: "toCollect" | "remarkOnly" } | null} */
function pickPayment(order, creditOriginal) {
  const payments = order.payment || [];
  const open = payments.filter((p) =>
    ["PENDING", "BANK_VERIFIED"].includes(p.paymentStatus)
  );
  const credit = parseNum(creditOriginal);

  const pickByCredit = (list) => {
    if (!list.length) return null;
    if (Number.isFinite(credit) && credit > 0) {
      const close = list.filter((p) => Math.abs(Number(p.paidAmount) - credit) <= 1);
      if (close.length === 1) return close[0];
      if (close.length > 1) {
        close.sort(
          (a, b) =>
            Math.abs(Number(a.paidAmount) - credit) -
            Math.abs(Number(b.paidAmount) - credit)
        );
        return close[0];
      }
    }
    return null;
  };

  const matchedOpen = pickByCredit(open);
  if (matchedOpen) return { payment: matchedOpen, mode: "toCollect" };

  const pending = open.find((p) => p.paymentStatus === "PENDING");
  if (pending) return { payment: pending, mode: "toCollect" };
  if (open[0]) return { payment: open[0], mode: "toCollect" };

  const collected = payments.filter((p) => p.paymentStatus === "COLLECTED");
  const matchedCol = pickByCredit(collected);
  if (matchedCol) return { payment: matchedCol, mode: "remarkOnly" };
  if (collected.length === 1) {
    return { payment: collected[0], mode: "remarkOnly" };
  }
  // Multiple COLLECTED lines: tie sheet credit_original to closest amount (remark audit only).
  if (collected.length > 1 && Number.isFinite(credit) && credit > 0) {
    const sorted = [...collected].sort(
      (a, b) =>
        Math.abs(Number(a.paidAmount) - credit) -
        Math.abs(Number(b.paidAmount) - credit)
    );
    return { payment: sorted[0], mode: "remarkOnly" };
  }

  return null;
}

/**
 * Dealer wallet credit for bulk (dealer) orders when marking non-wallet payment COLLECTED.
 * Wallet-tagged payments: PENDING/BANK_VERIFIED → COLLECTED has no wallet movement (order.controller.js).
 */
async function applyWalletBeforeSave(order, payment, previousStatus, performedBy) {
  if (payment.isWalletPayment) return;
  if (!order.dealerOrder || !order.dealer) return;
  if (previousStatus === "COLLECTED") return;

  const amount = Number(payment.paidAmount);
  await DealerWallet.addPayment(
    order.dealer,
    amount,
    `Payment collected for bulk order - credited to wallet for Order #${order._id}`,
    performedBy || order.dealer,
    "PAYMENT_STATUS_UPDATE",
    order._id
  );
}

function mergeRemark(existing) {
  const e = (existing && String(existing).trim()) || "";
  if (e.includes(REMARK)) return e;
  return e ? `${e} | ${REMARK}` : REMARK;
}

async function main() {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error(
      "Usage: node scripts/mark-collected-from-advance-match-xlsx.js <path-to.xlsx> [--dry-run]"
    );
    process.exit(1);
  }

  const dryRun = hasFlag("dry-run");
  const uri =
    process.env.PROD_MONGO_URL ||
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    process.env.DATABASE;
  if (!uri) {
    console.error("Set PROD_MONGO_URL or MONGO_URL (or MONGODB_URI / DATABASE)");
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.worksheets[0];
  if (!ws) {
    console.error("No worksheet in workbook");
    process.exit(1);
  }

  const h = headerMap(ws.getRow(1));
  const colOrder = h.order_number;
  const colCollected = h.COLLECTED;
  const colCredit = h.credit_original;
  if (!colOrder || !colCollected) {
    console.error("Sheet must have columns order_number and COLLECTED. Found:", Object.keys(h));
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(
    dryRun ? "DRY RUN — no writes" : "LIVE — will update MongoDB",
    "|",
    xlsxPath
  );

  const stats = {
    rowsTrue: 0,
    skippedNotTrue: 0,
    orderNotFound: 0,
    noOpenPayment: 0,
    alreadyCollected: 0,
    remarkOnly: 0,
    updated: 0,
    createdEmpty: 0,
    errors: 0,
  };

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (!row.hasValues) continue;

    const collectedVal = row.getCell(colCollected).value;
    if (!isCollectedCellTrue(collectedVal)) {
      stats.skippedNotTrue += 1;
      continue;
    }
    stats.rowsTrue += 1;

    const orderNum = parseNum(row.getCell(colOrder).value);
    if (!Number.isFinite(orderNum)) {
      console.warn(`Row ${r}: bad order_number`, row.getCell(colOrder).value);
      stats.errors += 1;
      continue;
    }

    const creditOriginal = colCredit ? row.getCell(colCredit).value : null;

    let order;
    try {
      order = await Order.findOne({ orderId: orderNum });
    } catch (e) {
      console.error(`Row ${r} order ${orderNum} query error:`, e.message);
      stats.errors += 1;
      continue;
    }
    if (!order) {
      console.warn(`Row ${r}: order not found orderId=${orderNum}`);
      stats.orderNotFound += 1;
      continue;
    }

    let picked = pickPayment(order, creditOriginal);
    const creditAmt = parseNum(creditOriginal);
    const paymentsEmpty = !order.payment || order.payment.length === 0;

    if (!picked && paymentsEmpty && Number.isFinite(creditAmt) && creditAmt > 0) {
      if (dryRun) {
        console.log(
          `DRY order ${orderNum} would CREATE first payment PENDING→COLLECTED amt=${creditAmt} (empty payment[])`
        );
        stats.createdEmpty += 1;
        continue;
      }
      try {
        order.payment.push({
          paidAmount: creditAmt,
          paymentStatus: "PENDING",
          paymentDate: new Date(),
          modeOfPayment: "CASH",
          remark: "",
          isWalletPayment: false,
        });
        await order.save();
        const payment = order.payment[order.payment.length - 1];
        await applyWalletBeforeSave(order, payment, "PENDING", null);
        payment.remark = mergeRemark(payment.remark);
        payment.paymentStatus = "COLLECTED";
        await order.save();

        if (!order.dealerOrder && order.farmer) {
          try {
            await ensureFarmerPlantOrderDebit(order, { userId: null });
            await recordFarmerPlantLedgerPaymentTransition(
              order,
              payment,
              "PENDING",
              "COLLECTED",
              { userId: null }
            );
          } catch (ledgerErr) {
            console.error(
              `Row ${r} order ${orderNum} ledger warning (created payment):`,
              ledgerErr.message
            );
          }
        }

        stats.createdEmpty += 1;
        console.log(
          `OK order ${orderNum} CREATED payment ${payment._id} PENDING→COLLECTED amt=${creditAmt}`
        );
        continue;
      } catch (e) {
        console.error(`Row ${r} order ${orderNum} CREATE payment FAILED:`, e.message);
        stats.errors += 1;
        continue;
      }
    }

    if (!picked) {
      console.warn(
        `Row ${r}: order ${orderNum} no matching payment (credit_original=${creditOriginal})`
      );
      stats.noOpenPayment += 1;
      continue;
    }

    const { payment, mode } = picked;

    if (mode === "remarkOnly") {
      if (String(payment.remark || "").includes(REMARK)) {
        stats.alreadyCollected += 1;
        continue;
      }
      if (!dryRun) {
        payment.remark = mergeRemark(payment.remark);
        await order.save();
      }
      stats.remarkOnly += 1;
      console.log(
        `Row ${r}: order ${orderNum} COLLECTED payment ${payment._id} — appended remark only (sheet=TRUE, already collected)`
      );
      continue;
    }

    const prev = payment.paymentStatus;
    if (prev === "COLLECTED") {
      if (String(payment.remark || "").includes(REMARK)) {
        stats.alreadyCollected += 1;
        continue;
      }
      if (!dryRun) {
        payment.remark = mergeRemark(payment.remark);
        await order.save();
      }
      stats.remarkOnly += 1;
      console.log(`Row ${r}: order ${orderNum} already COLLECTED — appended remark only`);
      continue;
    }

    if (!["PENDING", "BANK_VERIFIED"].includes(prev)) {
      console.warn(
        `Row ${r}: order ${orderNum} payment ${payment._id} status=${prev} (expected PENDING/BANK_VERIFIED)`
      );
      stats.errors += 1;
      continue;
    }

    if (dryRun) {
      console.log(
        `DRY order ${orderNum} payment ${payment._id} ${prev}→COLLECTED amt=${payment.paidAmount} sheetCredit=${creditOriginal}`
      );
      stats.updated += 1;
      continue;
    }


    try {
      await applyWalletBeforeSave(order, payment, prev, null);
      payment.remark = mergeRemark(payment.remark);
      payment.paymentStatus = "COLLECTED";
      await order.save();

      if (!order.dealerOrder && order.farmer) {
        try {
          await ensureFarmerPlantOrderDebit(order, { userId: null });
          await recordFarmerPlantLedgerPaymentTransition(
            order,
            payment,
            prev,
            "COLLECTED",
            { userId: null }
          );
        } catch (ledgerErr) {
          console.error(
            `Row ${r} order ${orderNum} ledger warning:`,
            ledgerErr.message
          );
        }
      }

      stats.updated += 1;
      console.log(`OK order ${orderNum} payment ${payment._id} ${prev}→COLLECTED`);
    } catch (e) {
      console.error(`Row ${r} order ${orderNum} FAILED:`, e.message);
      stats.errors += 1;
    }
  }

  console.log(JSON.stringify(stats, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
