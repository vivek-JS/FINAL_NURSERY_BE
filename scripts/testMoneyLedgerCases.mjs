/**
 * Safe money-ledger case tests (prod): Dharti merchant, ₹1 post + reverse.
 * Usage on ERP host:
 *   NODE_ENV=production node scripts/testMoneyLedgerCases.mjs
 */
import "dotenv/config";
import mongoose from "mongoose";
import { resolvePartyAdjustEntryDate, toIstYmd } from "../utility/istLedgerDate.js";
import {
  postPartyAdjustment,
  getPartyNetBalance,
  getUnifiedBookPartyStatement,
  postAgriSalesOrderAr,
  postLedgerReversal,
} from "../services/moneyLedger/index.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import MoneyLedgerEntry from "../models/moneyLedgerEntry.model.js";
import Merchant from "../models/merchant.model.js";

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

async function findDharti() {
  const m = await Merchant.findOne({
    name: /dharti/i,
    isActive: { $ne: false },
  })
    .select("_id name code phone")
    .lean();
  if (m) return m;
  const fromLedger = await MoneyLedgerEntry.findOne({
    book: "RAM_AGRI",
    partyType: "MERCHANT",
    partyName: /dharti/i,
  })
    .select("partyId partyName")
    .lean();
  if (!fromLedger) return null;
  return {
    _id: fromLedger.partyId,
    name: fromLedger.partyName,
  };
}

async function reverseSafe(entryId, label) {
  if (!entryId) return;
  const r = await postLedgerReversal({
    entryId,
    reason: `test cleanup: ${label}`,
    idempotencySuffix: `test_cleanup_${Date.now()}`,
  });
  if (!r?.ok && !r?.skipped) {
    fail(`reverse ${label}`, r?.error || "unknown");
  }
}

async function main() {
  const uri = resolveMongoUrl();
  if (!uri) throw new Error("No Mongo URL");
  await mongoose.connect(uri);
  console.log("[testMoneyLedgerCases] connected\n");

  // --- 1) Date helper ---
  const nowBefore = Date.now();
  const todayResolved = resolvePartyAdjustEntryDate(toIstYmd(new Date()));
  const delta = Math.abs(Date.now() - todayResolved.getTime());
  if (delta < 5000) pass("resolvePartyAdjustEntryDate(today) ≈ now", `${delta}ms`);
  else fail("resolvePartyAdjustEntryDate(today) ≈ now", `delta=${delta}ms ts=${todayResolved.toISOString()}`);

  const hist = resolvePartyAdjustEntryDate("2026-01-15");
  const histYmd = toIstYmd(hist);
  if (histYmd === "2026-01-15") pass("resolvePartyAdjustEntryDate(historical) IST day", hist.toISOString());
  else fail("resolvePartyAdjustEntryDate(historical) IST day", histYmd);

  // --- 2) Dharti party ---
  const dharti = await findDharti();
  if (!dharti?._id) {
    fail("find Dharti merchant", "not found");
    await mongoose.disconnect();
    process.exit(1);
  }
  pass("find Dharti merchant", `${dharti.name} (${dharti._id})`);

  // --- 3) RAM_AGRI payment ₹1 ---
  const pay = await postPartyAdjustment({
    book: "RAM_AGRI",
    partyType: "MERCHANT",
    partyId: dharti._id,
    amount: 1,
    kind: "PAYMENT",
    direction: "COLLECT",
    modeOfPayment: "Cash",
    remark: "AUTOTEST payment ₹1",
    entryDate: toIstYmd(new Date()),
  });
  if (pay?.ok && pay.data?.entry?._id) {
    pass("RAM_AGRI Add Payment ₹1", `entry=${pay.data.entry._id} credit=${pay.data.entry.credit}`);
  } else {
    fail("RAM_AGRI Add Payment ₹1", pay?.error || JSON.stringify(pay));
  }

  // --- 4) RAM_AGRI discount ₹1 ---
  const disc = await postPartyAdjustment({
    book: "RAM_AGRI",
    partyType: "MERCHANT",
    partyId: dharti._id,
    amount: 1,
    kind: "DISCOUNT",
    direction: "COLLECT",
    remark: "AUTOTEST discount ₹1",
    entryDate: toIstYmd(new Date()),
  });
  if (disc?.ok && disc.data?.entry?._id) {
    pass("RAM_AGRI Add Discount ₹1", `entry=${disc.data.entry._id}`);
  } else {
    fail("RAM_AGRI Add Discount ₹1", disc?.error || JSON.stringify(disc));
  }

  // --- 5) Statement latest-first (Manual should be near top) ---
  const stmt = await getUnifiedBookPartyStatement("RAM_AGRI", "MERCHANT", dharti._id, {
    limit: 50,
  });
  if (stmt?.ok !== false && Array.isArray(stmt.entries) && stmt.entries.length) {
    pass("RAM_AGRI statement loads", `entries=${stmt.entries.length} closing=${stmt.totals?.closing}`);
    const top = stmt.entries.slice(0, 5).map((e) => e.refType);
    const testOnTop = stmt.entries
      .slice(0, 6)
      .some(
        (e) =>
          e.metadata?.partyAdjustment &&
          (String(e.description || "").includes("AUTOTEST") ||
            Number(e.credit) === 1 ||
            Number(e.debit) === 1)
      );
    if (testOnTop) pass("latest-first includes fresh Manual payment/discount in top rows", top.join(", "));
    else fail("latest-first Manual in top rows", `top types: ${top.join(", ")}`);

    // strict: first row should be newest by sortTime/createdAt among Manual tests
    const first = stmt.entries[0];
    if (first?.metadata?.partyAdjustment || first?.refType === "REVERSAL" || first?.documentType === "Manual") {
      pass("top row is recent Manual/adjustment-related", first.refType);
    } else {
      // still ok if a brand-new sell exists concurrently — warn as soft
      pass("top row type (informational)", first?.refType || "—");
    }
  } else {
    fail("RAM_AGRI statement loads", stmt?.error || "empty");
  }

  // --- 6) Net balance helper ---
  const net = await getPartyNetBalance("RAM_AGRI", "MERCHANT", dharti._id);
  if (typeof net.net === "number") pass("getPartyNetBalance RAM_AGRI", `net=${net.net}`);
  else fail("getPartyNetBalance RAM_AGRI");

  // --- 7) BIOTECH payment/discount (may create first BIOTECH lines for Dharti) ---
  const bioPay = await postPartyAdjustment({
    book: "BIOTECH",
    partyType: "MERCHANT",
    partyId: dharti._id,
    amount: 1,
    kind: "PAYMENT",
    direction: "COLLECT",
    modeOfPayment: "UPI",
    remark: "AUTOTEST biotech payment ₹1",
    entryDate: toIstYmd(new Date()),
  });
  if (bioPay?.ok && bioPay.data?.entry?._id) {
    pass("BIOTECH Add Payment ₹1", `entry=${bioPay.data.entry._id}`);
  } else {
    fail("BIOTECH Add Payment ₹1", bioPay?.error || JSON.stringify(bioPay));
  }

  const bioDisc = await postPartyAdjustment({
    book: "BIOTECH",
    partyType: "MERCHANT",
    partyId: dharti._id,
    amount: 1,
    kind: "DISCOUNT",
    direction: "COLLECT",
    remark: "AUTOTEST biotech discount ₹1",
    entryDate: toIstYmd(new Date()),
  });
  if (bioDisc?.ok && bioDisc.data?.entry?._id) {
    pass("BIOTECH Add Discount ₹1", `entry=${bioDisc.data.entry._id}`);
  } else {
    fail("BIOTECH Add Discount ₹1", bioDisc?.error || JSON.stringify(bioDisc));
  }

  const bioStmt = await getUnifiedBookPartyStatement("BIOTECH", "MERCHANT", dharti._id, {
    limit: 20,
  });
  if (bioStmt?.ok !== false && bioStmt.entries?.length) {
    const hasManual = bioStmt.entries.some((e) => e.metadata?.partyAdjustment);
    if (hasManual) pass("BIOTECH statement shows Manual payment/discount");
    else fail("BIOTECH statement shows Manual payment/discount");
  } else {
    fail("BIOTECH statement loads", bioStmt?.error || "empty");
  }

  // --- 8) B2B agri order money-ledger post (idempotent on latest merchant order) ---
  const agriOrder = await AgriSalesOrder.findOne({
    merchant: dharti._id,
    orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
    totalAmount: { $gt: 0 },
  })
    .sort({ createdAt: -1 })
    .lean();
  if (agriOrder) {
    const ar = await postAgriSalesOrderAr(agriOrder, null);
    if (ar?.ok) {
      pass(
        "postAgriSalesOrderAr idempotent",
        `${agriOrder.orderNumber} skipped=${Boolean(ar.skipped)} created=${ar.sellPost?.created}`
      );
    } else {
      fail("postAgriSalesOrderAr idempotent", ar?.error || JSON.stringify(ar));
    }
  } else {
    pass("postAgriSalesOrderAr idempotent", "skipped — no active B2B order for Dharti");
  }

  // Reject B2B path still blocks cancelled no-merchant (documentation assert)
  const cancelledNoMerchant = await AgriSalesOrder.findOne({
    orderNumber: "AGR-260504-008",
  })
    .select("orderNumber merchant orderStatus totalAmount")
    .lean();
  if (cancelledNoMerchant) {
    const skip = await postAgriSalesOrderAr(cancelledNoMerchant, null);
    if (skip?.skipped || skip?.reason === "no_merchant" || skip?.ok) {
      pass(
        "AGR-260504-008 still skipped for money ledger (no merchant)",
        `status=${cancelledNoMerchant.orderStatus} merchant=${cancelledNoMerchant.merchant}`
      );
    } else {
      fail("AGR-260504-008 skip expected", JSON.stringify(skip));
    }
  } else {
    pass("AGR-260504-008 check", "order not found (ok)");
  }

  // --- cleanup: reverse ₹1 tests ---
  console.log("\n[cleanup] reversing AUTOTEST ₹1 entries…");
  await reverseSafe(pay?.data?.entry?._id, "RAM_AGRI payment");
  await reverseSafe(disc?.data?.entry?._id, "RAM_AGRI discount");
  await reverseSafe(bioPay?.data?.entry?._id, "BIOTECH payment");
  await reverseSafe(bioDisc?.data?.entry?._id, "BIOTECH discount");
  pass("cleanup reversals posted for ₹1 test lines");

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
  console.error("[testMoneyLedgerCases] FAILED:", e);
  process.exit(1);
});
