/**
 * API test script: Dealer Ledger, Plant Ledger, Wallet & stock-related endpoints
 *
 * Usage:
 *   1. Start backend: npm run dev  (or node index.js)
 *   2. Run: node scripts/test-dealer-ledger-and-stock-api.js
 *
 * Optional env:
 *   BASE_URL=http://localhost:8000
 *   AUTH_TOKEN=<jwt>   (if endpoints require auth)
 */

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const BASE = (process.env.BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

const api = axios.create({
  baseURL: BASE,
  timeout: 15000,
  headers: {
    "Content-Type": "application/json",
    ...(AUTH_TOKEN && { Authorization: `Bearer ${AUTH_TOKEN}` }),
  },
});

function log(name, ok, detail = "") {
  const icon = ok ? "✅" : "❌";
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("\n========== Dealer Ledger & Stock API Tests ==========\n");
  console.log(`Base URL: ${BASE}`);
  console.log(`Auth: ${AUTH_TOKEN ? "Token provided" : "No token"}\n`);

  let dealerId = null;

  // --- 1) Get dealers list ---
  try {
    const res = await api.get("/api/v1/user/dealers");
    const ok = res.status === 200 && Array.isArray(res.data?.data);
    log("GET /api/v1/user/dealers", ok, ok ? `count: ${res.data.data.length}` : res.statusText);
    if (ok && res.data.data.length > 0) {
      dealerId = res.data.data[0]._id || res.data.data[0].id;
      if (!dealerId && res.data.data[0].dealer) dealerId = res.data.data[0].dealer;
      console.log(`   Using dealerId: ${dealerId}`);
    }
  } catch (e) {
    log("GET /api/v1/user/dealers", false, e.response?.data?.message || e.message);
  }

  if (!dealerId) {
    console.log("\n⚠️  No dealer ID available. Use a valid dealer _id as DEALER_ID env to test ledger endpoints.");
    dealerId = process.env.DEALER_ID;
  }

  if (dealerId) {
    // --- 2) Dealer Wallet Ledger (audit) ---
    try {
      const res = await api.get(`/api/v1/user/dealers/${dealerId}/ledger`, {
        params: { page: 1, limit: 5 },
      });
      const ok = res.status === 200 && res.data?.success === true;
      const data = res.data?.data;
      log("GET /api/v1/user/dealers/:dealerId/ledger", ok);
      if (ok && data) {
        console.log(`   entries: ${data.entries?.length ?? 0}, summary: totalDebit=${data.summary?.totalDebit ?? 0}, totalCredit=${data.summary?.totalCredit ?? 0}, balance=${data.summary?.balance ?? 0}`);
        console.log(`   pagination: page=${data.pagination?.page}, total=${data.pagination?.total}`);
      }
    } catch (e) {
      log("GET /api/v1/user/dealers/:dealerId/ledger", false, e.response?.data?.message || e.message);
    }

    // --- 3) Dealer Plant Ledger (quota movements) ---
    try {
      const res = await api.get(`/api/v1/user/dealers/${dealerId}/plant-ledger`, {
        params: { page: 1, limit: 5 },
      });
      const ok = res.status === 200 && res.data?.success === true;
      const data = res.data?.data;
      log("GET /api/v1/user/dealers/:dealerId/plant-ledger", ok);
      if (ok && data) {
        console.log(`   entries: ${data.entries?.length ?? 0}, pagination total: ${data.pagination?.total ?? 0}`);
      }
    } catch (e) {
      log("GET /api/v1/user/dealers/:dealerId/plant-ledger", false, e.response?.data?.message || e.message);
    }

    // --- 4) Wallet details ---
    try {
      const res = await api.get(`/api/v1/user/wallet-details/${dealerId}`);
      const ok = res.status === 200;
      const data = res.data?.data;
      log("GET /api/v1/user/wallet-details/:dealerId", ok);
      if (ok && data) {
        const fin = data.financial || {};
        console.log(`   availableAmount: ${fin.availableAmount ?? 0}, totalOrderAmount: ${fin.totalOrderAmount ?? 0}, totalPaidAmount: ${fin.totalPaidAmount ?? 0}`);
      }
    } catch (e) {
      log("GET /api/v1/user/wallet-details/:dealerId", false, e.response?.data?.message || e.message);
    }

    // --- 5) Dealer transactions (embedded wallet txns) ---
    try {
      const res = await api.get(`/api/v1/user/dealers/transactions/${dealerId}`, {
        params: { page: 1, limit: 5 },
      });
      const ok = res.status === 200;
      const data = res.data?.data;
      log("GET /api/v1/user/dealers/transactions/:dealerId", ok);
      if (ok && data) {
        console.log(`   transactions: ${data.transactions?.length ?? 0}, pagination total: ${data.pagination?.total ?? 0}`);
      }
    } catch (e) {
      log("GET /api/v1/user/dealers/transactions/:dealerId", false, e.response?.data?.message || e.message);
    }
  }

  // --- 6) Health (no auth) ---
  try {
    const res = await api.get("/health");
    log("GET /health", res.status === 200);
  } catch (e) {
    log("GET /health", false, e.message);
  }

  console.log("\n========== Done ==========\n");
  console.log("Stock / deduction flow (for manual verification):");
  console.log("  - Dealer order create → factory.controller: INVENTORY_ADD + INVENTORY_BOOK in plant ledger; wallet + dealer ledger on payment.");
  console.log("  - Quota allocate → quota.controller: INVENTORY_BOOK in plant ledger.");
  console.log("  - Order reject (dealer as salesperson) → factory.controller: INVENTORY_RELEASE in plant ledger; quota restored.");
  console.log("  - addPayment on DealerWallet → dealerLedgerHelper: ORDER_PAYMENT/PAYMENT_STATUS_UPDATE entries in dealer ledger.");
  console.log("");
}

main().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
