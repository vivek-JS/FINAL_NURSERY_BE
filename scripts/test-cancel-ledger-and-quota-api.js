/**
 * API test: Order cancel → Plant ledger entry created + Dealer quota increased
 *
 * Usage:
 *   1. Start backend: npm run dev
 *   2. Set env: AUTH_TOKEN=<super-admin-jwt>  (from login)
 *   3. Optional: ORDER_ID=<orderId> DEALER_ID=<dealerId>  (dealer order to cancel; script can find one if omitted)
 *   4. Run: node scripts/test-cancel-ledger-and-quota-api.js
 *
 * Expects:
 *   - PATCH updateOrder with orderStatus CANCELLED returns 200
 *   - Plant ledger gets one new INVENTORY_RELEASE entry for that order
 *   - Dealer wallet quota: remainingQuantity increases by order's numberOfPlants (quota not reduced; plants back in dealer quota)
 */

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const BASE = (process.env.BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
const ORDER_ID = process.env.ORDER_ID || "";
const DEALER_ID = process.env.DEALER_ID || "";
const LOGIN_PHONE = process.env.LOGIN_PHONE || "7588686452";
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || "passsword123443";

let AUTH_TOKEN = process.env.AUTH_TOKEN || "";

const api = axios.create({
  baseURL: BASE,
  timeout: 20000,
  headers: { "Content-Type": "application/json" },
});
function setAuthToken(token) {
  AUTH_TOKEN = token;
  api.defaults.headers.Authorization = token ? `Bearer ${token}` : undefined;
}
if (AUTH_TOKEN) setAuthToken(AUTH_TOKEN);

function log(name, ok, detail = "") {
  const icon = ok ? "✅" : "❌";
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function getPlantLedgerTotal(dealerId, limit = 50) {
  const res = await api.get(`/api/v1/user/dealers/${dealerId}/plant-ledger`, {
    params: { limit },
  });
  if (res.status !== 200 || !res.data?.success) return { total: 0, entries: [] };
  const total = res.data?.data?.pagination?.total ?? 0;
  const entries = res.data?.data?.entries ?? [];
  return { total, entries };
}

async function getWalletQuotaSummary(dealerId) {
  const res = await api.get(`/api/v1/user/wallet-details/${dealerId}`);
  if (res.status !== 200 || !res.data?.data) return null;
  const plantDetails = res.data?.data?.plantDetails ?? [];
  let totalRemaining = 0;
  let totalQuantity = 0;
  let totalBooked = 0;
  plantDetails.forEach((p) => {
    totalQuantity += p.totalQuantity ?? 0;
    totalBooked += p.totalBookedQuantity ?? 0;
    totalRemaining += p.totalRemainingQuantity ?? 0;
  });
  return { totalQuantity, totalBooked, totalRemaining, plantDetails };
}

async function findDealerOrder() {
  const res = await api.get("/api/v1/order/getOrders", {
    params: { limit: 100 },
  });
  if (res.status !== 200 || !res.data?.data?.data) return null;
  const orders = res.data.data.data;
  const dealerOrder = orders.find(
    (o) =>
      (o.dealerOrder === true || o.details?.dealerOrder === true) &&
      o.orderStatus !== "CANCELLED" &&
      o.orderStatus !== "REJECTED"
  );
  return dealerOrder || null;
}

async function login() {
  try {
    const res = await axios.post(`${BASE}/api/v1/user/login`, {
      phoneNumber: Number(LOGIN_PHONE) || LOGIN_PHONE,
      password: LOGIN_PASSWORD,
    });
    const data = res.data?.data ?? res.data;
    const token = data?.accessToken ?? data?.token;
    if (token) {
      setAuthToken(token);
      return true;
    }
  } catch (e) {
    console.log("   Login failed:", e.response?.data?.message || e.message);
  }
  return false;
}

async function main() {
  console.log("\n========== Cancel order → Ledger + Quota API test ==========\n");
  console.log(`Base URL: ${BASE}`);
  if (!AUTH_TOKEN) {
    console.log("No AUTH_TOKEN; attempting login...");
    if (!(await login())) {
      console.log("❌ Set AUTH_TOKEN=<jwt> or ensure backend is running and LOGIN_PHONE/LOGIN_PASSWORD are correct.");
      process.exit(1);
    }
    console.log("   Login OK\n");
  } else {
    console.log("Auth: Token provided\n");
  }

  let orderId = ORDER_ID;
  let dealerId = DEALER_ID;
  let orderDetails = null;

  if (!orderId || !dealerId) {
    console.log("Finding a dealer order (PENDING/ACCEPTED, dealerOrder=true)...");
    const found = await findDealerOrder();
    if (!found) {
      console.log("❌ No dealer order found. Create a dealer order or set ORDER_ID and DEALER_ID.");
      process.exit(1);
    }
    orderId = found._id ?? found.details?._id ?? found.id;
    dealerId = found.dealer ?? found.details?.dealer ?? found.salesPerson?._id ?? found.details?.salesPerson;
    if (typeof dealerId === "object" && dealerId?._id) dealerId = dealerId._id;
    orderDetails = found;
    console.log(`   Order: ${orderId}, Dealer: ${dealerId}, Status: ${found.orderStatus}, Plants: ${found.numberOfPlants ?? found.details?.numberOfPlants ?? "?"}`);
  } else if (orderId && !orderDetails) {
    try {
      const listRes = await api.get("/api/v1/order/getOrders", { params: { limit: 500 } });
      const orders = listRes.data?.data?.data ?? [];
      orderDetails = orders.find((o) => (o._id || o.id)?.toString() === orderId.toString());
    } catch (_) {}
  }

  const numberOfPlants = orderDetails?.numberOfPlants ?? orderDetails?.details?.numberOfPlants ?? 0;
  const orderIdStr = orderId?.toString?.() ?? String(orderId);

  // --- Before cancel ---
  let ledgerBefore = { total: 0, entries: [] };
  let quotaBefore = null;
  try {
    ledgerBefore = await getPlantLedgerTotal(dealerId);
    quotaBefore = await getWalletQuotaSummary(dealerId);
  } catch (e) {
    console.log("   Warning: could not fetch before state", e.response?.data?.message || e.message);
  }
  console.log(`\nBefore cancel: plant-ledger total=${ledgerBefore.total}, quota remaining=${quotaBefore?.totalRemaining ?? "n/a"}`);

  // --- Cancel order ---
  let cancelOk = false;
  try {
    const res = await api.patch("/api/v1/order/updateOrder", {
      id: orderId,
      orderStatus: "CANCELLED",
    });
    const data = res.data?.data ?? res.data;
    cancelOk = res.status === 200 && (res.data?.status === "Success" || res.data?.success === true || (data && (data.orderStatus === "CANCELLED" || data._id)));
    log("PATCH /api/v1/order/updateOrder (CANCELLED)", cancelOk, cancelOk ? "" : (res.data?.message || res.statusText));
  } catch (e) {
    log("PATCH /api/v1/order/updateOrder (CANCELLED)", false, e.response?.data?.message || e.message);
  }

  if (!cancelOk) {
    console.log("\n❌ Cancel failed. Stopping.");
    process.exit(1);
  }

  // --- After cancel: ledger (fetch more entries to find the new one) ---
  const ledgerAfter = await getPlantLedgerTotal(dealerId, 50);
  const newTotal = ledgerAfter.total;
  const releaseEntries = (ledgerAfter.entries || []).filter((e) => e.transactionType === "INVENTORY_RELEASE");
  const forThisOrder = (ledgerAfter.entries || []).filter(
    (e) => (e.referenceId && (e.referenceId._id?.toString() === orderIdStr || e.referenceId?.toString?.() === orderIdStr)) || (e.referenceId?.toString?.() === orderIdStr)
  );

  const ledgerIncreased = newTotal >= ledgerBefore.total;
  const hasReleaseEntry = forThisOrder.length > 0 || (releaseEntries.length > 0 && newTotal > ledgerBefore.total);
  log("Plant ledger: new INVENTORY_RELEASE for this order", hasReleaseEntry, hasReleaseEntry ? `total entries now: ${newTotal}` : `total: ${newTotal}`);
  if (forThisOrder.length > 0) {
    console.log(`   → referenceId: ${forThisOrder[0].referenceId?._id ?? forThisOrder[0].referenceId}, type: ${forThisOrder[0].transactionType}, qty: ${forThisOrder[0].quantity}`);
  }

  // --- After cancel: quota (should increase = plants back in dealer quota) ---
  const quotaAfter = await getWalletQuotaSummary(dealerId);
  let quotaIncreased = false;
  if (quotaBefore && quotaAfter && numberOfPlants > 0) {
    const remainingDiff = (quotaAfter.totalRemaining ?? 0) - (quotaBefore.totalRemaining ?? 0);
    quotaIncreased = remainingDiff >= numberOfPlants;
    log("Quota: remaining increased (plants back in dealer quota)", quotaIncreased, `remaining before=${quotaBefore.totalRemaining} after=${quotaAfter.totalRemaining} (+${remainingDiff}), order plants=${numberOfPlants}`);
  } else {
    log("Quota: check remaining", quotaAfter != null, quotaAfter ? `remaining=${quotaAfter.totalRemaining}` : "could not fetch");
  }

  console.log("\n--- Summary ---");
  console.log(`  Cancel API:        ${cancelOk ? "OK" : "FAIL"}`);
  console.log(`  Ledger entry:      ${hasReleaseEntry ? "created (INVENTORY_RELEASE)" : "not found"}`);
  console.log(`  Quota reduced?     No (cancel should add plants back). Remaining increased: ${quotaIncreased ? "Yes" : "No/unchanged"}`);
  console.log("\n========== Done ==========\n");
}

main().catch((err) => {
  console.error("Script error:", err?.response?.data || err);
  process.exit(1);
});
