/**
 * Coverage test: sell / GRN purchase / sale return / purchase return → MoneyLedgerEntry.
 * Safe read-only (+ optional deep link checks). No money posts.
 *
 * NODE_ENV=production node scripts/testMoneyLedgerCoverage.mjs
 */
import "dotenv/config";
import mongoose from "mongoose";

function resolveMongoUrl() {
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    return process.env.PROD_MONGO_URL || process.env.MONGO_URL || process.env.MONGODB_URI || "";
  }
  return process.env.MONGO_URL || process.env.STAGE_MONGO_URL || process.env.MONGODB_URI || "";
}

const results = [];
function pass(name, detail = "") {
  results.push({ ok: true, name, detail });
  console.log(`✅ PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  results.push({ ok: false, name, detail });
  console.error(`❌ FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function grnAmt(g) {
  if (Number(g.totalAmount) > 0) return Number(g.totalAmount);
  return (g.items || []).reduce((s, i) => {
    const qty = Number(i.acceptedQuantity ?? i.quantity) || 0;
    const rate = Number(i.rate) || 0;
    const amount = Number(i.amount);
    if (Number.isFinite(amount) && amount > 0) return s + amount;
    return s + qty * rate;
  }, 0);
}

async function main() {
  const uri = resolveMongoUrl();
  if (!uri) throw new Error("No Mongo URL");
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const ml = db.collection("moneyledgerentries");
  console.log("[testMoneyLedgerCoverage] connected\n");

  // ----- 1) Agri B2B SELL -----
  const agriB2b = await db
    .collection("agrisalesorders")
    .find({
      merchant: { $exists: true, $ne: null },
      totalAmount: { $gt: 0 },
      orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
    })
    .project({ _id: 1, orderNumber: 1, totalAmount: 1, merchant: 1 })
    .toArray();

  const agriSellByDoc = await ml
    .find({ book: "RAM_AGRI", refType: "SELL", documentType: "AgriSalesOrder" })
    .project({ documentId: 1, documentNumber: 1, debit: 1 })
    .toArray();
  const agriSellSet = new Set(agriSellByDoc.map((e) => String(e.documentId)));
  const agriMissing = agriB2b.filter((o) => !agriSellSet.has(String(o._id)));
  if (agriMissing.length === 0) {
    pass("Agri B2B SELL ledger coverage", `${agriB2b.length}/${agriB2b.length}`);
  } else {
    fail(
      "Agri B2B SELL ledger coverage",
      `missing ${agriMissing.length}: ${agriMissing.map((o) => o.orderNumber).join(", ")}`
    );
  }

  // AGR-260504-008 must NOT have SELL
  const o008 = await db.collection("agrisalesorders").findOne({ orderNumber: "AGR-260504-008" });
  if (o008) {
    const has = await ml.findOne({
      documentType: "AgriSalesOrder",
      documentId: o008._id,
      refType: "SELL",
    });
    if (!has) pass("AGR-260504-008 has no SELL ledger (expected)");
    else fail("AGR-260504-008 has no SELL ledger (expected)", "SELL entry exists");
  } else {
    pass("AGR-260504-008 check", "order not in DB");
  }

  // ----- 2) GRN PURCHASE (amount > 0) -----
  const grns = await db
    .collection("grns")
    .find({ status: { $in: ["approved", "APPROVED", "Approved"] } })
    .project({ _id: 1, grnNumber: 1, totalAmount: 1, items: 1, purchaseOrder: 1 })
    .toArray();
  const withAmt = grns.filter((g) => grnAmt(g) > 0);
  const zeroAmt = grns.filter((g) => grnAmt(g) <= 0);

  const purchaseEntries = await ml
    .find({ refType: "PURCHASE" })
    .project({ documentId: 1, documentNumber: 1, book: 1, credit: 1 })
    .toArray();
  const purchaseIds = new Set(purchaseEntries.map((e) => String(e.documentId)));
  const purchaseNums = new Set(purchaseEntries.map((e) => String(e.documentNumber || "")).filter(Boolean));

  const grnMissing = withAmt.filter((g) => {
    const gid = String(g._id);
    const num = String(g.grnNumber || "");
    const pid = g.purchaseOrder ? String(g.purchaseOrder) : "";
    return !purchaseIds.has(gid) && !(num && purchaseNums.has(num)) && !(pid && purchaseIds.has(pid));
  });

  if (grnMissing.length === 0) {
    pass(
      "Approved GRN with amount → PURCHASE ledger",
      `${withAmt.length}/${withAmt.length} (skipped zero ₹: ${zeroAmt.length})`
    );
  } else {
    fail(
      "Approved GRN with amount → PURCHASE ledger",
      `missing ${grnMissing.length}: ${grnMissing.map((g) => g.grnNumber).join(", ")}`
    );
  }

  // Zero-amount GRNs should generally have no PURCHASE
  const zeroWithPurchase = [];
  for (const g of zeroAmt) {
    const hit = await ml.findOne({
      refType: "PURCHASE",
      $or: [{ documentId: g._id }, { documentNumber: g.grnNumber }],
    });
    if (hit) zeroWithPurchase.push(g.grnNumber);
  }
  if (zeroWithPurchase.length === 0) {
    pass("Zero-amount GRNs have no PURCHASE ledger", `${zeroAmt.length} checked`);
  } else {
    fail("Zero-amount GRNs have no PURCHASE ledger", zeroWithPurchase.join(", "));
  }

  // ----- 3) Sale returns -----
  const saleReturns = await db
    .collection("agrisalesreturnrequests")
    .find({ status: { $in: ["APPROVED", "approved"] } })
    .toArray();

  let srOk = 0;
  const srFail = [];
  for (const r of saleReturns) {
    const orderId = r.order || r.agriSalesOrder || r.orderId;
    const amt = Number(r.totalReturnAmount || r.creditAmount || r.amount || r.refundAmount || 0);
    const hit = await ml.findOne({
      refType: "SALES_RETURN",
      $or: [
        { "metadata.salesReturnId": r._id },
        { "metadata.returnRequestId": r._id },
        { "metadata.returnId": r._id },
        ...(orderId ? [{ documentId: orderId, credit: amt > 0 ? amt : { $gt: 0 } }] : []),
      ],
    });
    // broader: any SALES_RETURN for order
    const hit2 =
      hit ||
      (orderId
        ? await ml.findOne({ refType: "SALES_RETURN", documentId: orderId })
        : null);
    if (hit2) srOk += 1;
    else srFail.push(String(r._id));
  }
  if (saleReturns.length === 0) {
    pass("Approved sale returns → SALES_RETURN ledger", "no approved returns");
  } else if (srFail.length === 0) {
    pass("Approved sale returns → SALES_RETURN ledger", `${srOk}/${saleReturns.length}`);
  } else {
    fail("Approved sale returns → SALES_RETURN ledger", `missing ${srFail.join(", ")}`);
  }

  // amounts match sample
  for (const r of saleReturns) {
    const orderId = r.order || r.agriSalesOrder || r.orderId;
    const amt = Number(r.totalReturnAmount || r.creditAmount || r.amount || r.refundAmount || 0);
    if (!(amt > 0) || !orderId) continue;
    const e = await ml.findOne({
      refType: "SALES_RETURN",
      documentId: orderId,
      credit: amt,
    });
    if (e) pass(`Sale return amount match ₹${amt}`, String(orderId));
    else fail(`Sale return amount match ₹${amt}`, String(r._id));
  }

  // ----- 4) Purchase returns -----
  const prs = await db.collection("purchasereturns").find({}).toArray();
  const prActive = prs.filter(
    (d) => !["DRAFT", "CANCELLED", "REJECTED", "draft"].includes(String(d.status || ""))
  );
  const prWithAmt = prActive.filter((d) => Number(d.totalAmount || d.creditAmount || 0) > 0);
  const prZero = prActive.filter((d) => Number(d.totalAmount || d.creditAmount || 0) <= 0);

  let prOk = 0;
  const prFail = [];
  for (const pr of prWithAmt) {
    const hit = await ml.findOne({
      refType: "PURCHASE_RETURN",
      $or: [{ documentId: pr._id }, { documentNumber: pr.returnNumber }],
    });
    if (hit) prOk += 1;
    else prFail.push(pr.returnNumber || String(pr._id));
  }
  if (prWithAmt.length === 0) {
    pass("Purchase return (amount>0) → PURCHASE_RETURN ledger", "none eligible");
  } else if (prFail.length === 0) {
    pass("Purchase return (amount>0) → PURCHASE_RETURN ledger", `${prOk}/${prWithAmt.length}`);
  } else {
    fail("Purchase return (amount>0) → PURCHASE_RETURN ledger", prFail.join(", "));
  }

  for (const pr of prZero) {
    const hit = await ml.findOne({
      refType: "PURCHASE_RETURN",
      $or: [{ documentId: pr._id }, { documentNumber: pr.returnNumber }],
    });
    if (!hit) pass(`Zero ₹ PR skipped (${pr.returnNumber})`);
    else fail(`Zero ₹ PR skipped (${pr.returnNumber})`, "ledger exists");
  }

  // ----- 5) Classic Biotech merchant sells -----
  let sellCol = null;
  for (const c of ["merchantsellorders", "sellorders"]) {
    if (await db.listCollections({ name: c }).hasNext()) {
      sellCol = c;
      break;
    }
  }
  if (sellCol) {
    const sells = await db
      .collection(sellCol)
      .find({ merchant: { $exists: true, $ne: null }, totalAmount: { $gt: 0 } })
      .project({ _id: 1, orderNumber: 1, status: 1, orderStatus: 1 })
      .toArray();
    const active = sells.filter((o) => {
      const s = String(o.status || o.orderStatus || "").toUpperCase();
      return !["CANCELLED", "CANCELED", "REJECTED"].includes(s);
    });
    const sellIds = new Set(
      (
        await ml
          .find({ book: "BIOTECH", refType: "SELL", documentType: "SellOrder" })
          .project({ documentId: 1 })
          .toArray()
      ).map((e) => String(e.documentId))
    );
    const miss = active.filter((o) => !sellIds.has(String(o._id)));
    if (active.length === 0) {
      pass("Biotech merchant SellOrder coverage", "0 eligible docs in DB");
    } else if (miss.length === 0) {
      pass("Biotech merchant SellOrder coverage", `${active.length}/${active.length}`);
    } else {
      fail(
        "Biotech merchant SellOrder coverage",
        `missing ${miss.length}: ${miss.map((o) => o.orderNumber).slice(0, 8).join(", ")}`
      );
    }
  } else {
    pass("Biotech merchant SellOrder coverage", "no sell collection");
  }

  // ----- summary tables -----
  const byRef = await ml
    .aggregate([
      { $group: { _id: { book: "$book", refType: "$refType" }, n: { $sum: 1 } } },
      { $sort: { "_id.book": 1, n: -1 } },
    ])
    .toArray();
  console.log("\nLedger snapshot:");
  for (const r of byRef) {
    console.log(`  ${r._id.book} ${r._id.refType}: ${r.n}`);
  }

  await mongoose.disconnect();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== SUMMARY: ${results.length - failed.length}/${results.length} passed ====`);
  if (failed.length) {
    failed.forEach((f) => console.error(` - ${f.name}: ${f.detail}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[testMoneyLedgerCoverage] FAILED:", e);
  process.exit(1);
});
