/**
 * Seed one farmer order per day from 21 Jul 2026 through 21 Aug 2026 (local API).
 * Same plant/subtype as sample curl; mixes RAISING vs COMPANY sowing plans.
 *
 * Usage:
 *   node scripts/seed-farmer-orders-jul-aug-local.js
 *   node scripts/seed-farmer-orders-jul-aug-local.js --company-only
 *   node scripts/seed-farmer-orders-jul-aug-local.js --start=2026-08-22 --end=2026-09-21 --company-only --mobile-offset=200
 *   node scripts/seed-farmer-orders-jul-aug-local.js --dry-run
 *
 * Env:
 *   API_BASE_URL (default http://localhost:8000)
 *   SEED_AUTH_TOKEN or SUPER_ADMIN_TOKEN (Bearer for createFarmer)
 */
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";
const AUTH_TOKEN =
  process.env.SEED_AUTH_TOKEN ||
  process.env.SUPER_ADMIN_TOKEN ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2ODY5ZmYwNzllNTJlZmU2MTg0YWVjM2EiLCJwaG9uZU51bWJlciI6NzU4ODY4NjQ1Miwicm9sZSI6IlNVUEVSX0FETUlOIiwiam9iVGl0bGUiOiJTVVBFUl9BRE1JTiIsIm5hbWUiOiJTdXBlciBBZG1pbiIsInR5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3ODYwODk3ODMsImV4cCI6MTc4NjE3NjE4MywiYXVkIjoibnVyc2VyeS11c2VycyIsImlzcyI6Im51cnNlcnktYXBwIn0.6_ouQJHB7gHsPsm_x8Cf_mlsj099w-m1koGcL-ivufI";

const CONFIG = {
  plantName: "69cb7cbbb6eb3413378d0253",
  plantSubtype: "69cb7cbbb6eb3413378d0254",
  cavity: "6872aac27ef8a7608cebbdcf",
  salesPerson: "69c74ec5907e05dc6f158621",
  startDate: "2026-07-21",
  endDate: "2026-08-21",
  rate: 12,
  village: "Abit Khind",
  taluka: "Akola",
  district: "Ahmadnagar",
  state: "Maharashtra",
};

const QUANTITIES = [50, 75, 100, 120, 150, 180, 200, 250, 300];
const FIRST_NAMES = [
  "Kiran",
  "Ramesh",
  "Suresh",
  "Ganesh",
  "Prakash",
  "Vijay",
  "Sanjay",
  "Mahesh",
  "Dattatray",
  "Balu",
  "Nitin",
  "Sachin",
  "Rahul",
  "Anil",
  "Sunil",
  "Ashok",
];

function readArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const DRY_RUN = process.argv.includes("--dry-run");
const COMPANY_ONLY = process.argv.includes("--company-only");
const MOBILE_OFFSET = Number(readArg("mobile-offset", "0")) || 0;
const START_DATE = readArg("start", CONFIG.startDate);
const END_DATE = readArg("end", CONFIG.endDate);

function parseSlotDate(value) {
  const [dd, mm, yyyy] = value.split("-").map(Number);
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

function parseIsoDate(isoDate) {
  const [yyyy, mm, dd] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

function toIsoDelivery(dateStr) {
  return `${dateStr}T18:30:00.000Z`;
}

function toIsoBooking(dateStr) {
  return `${dateStr}T07:20:22.449Z`;
}

function* dateRange(startStr, endStr) {
  const start = parseIsoDate(startStr);
  const end = parseIsoDate(endStr);
  const cur = new Date(start);
  while (cur <= end) {
    const yyyy = cur.getUTCFullYear();
    const mm = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(cur.getUTCDate()).padStart(2, "0");
    yield `${yyyy}-${mm}-${dd}`;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

function findSlotForDate(slots, isoDate) {
  const target = parseIsoDate(isoDate);
  return (
    slots.find((slot) => {
      const start = parseSlotDate(slot.startDay);
      const end = parseSlotDate(slot.endDay);
      return target >= start && target <= end;
    }) || null
  );
}

async function fetchSlots() {
  const url = `${API_BASE_URL}/api/v1/slots/simple?plantId=${CONFIG.plantName}&subtypeId=${CONFIG.plantSubtype}&year=2026`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  const body = await res.json();
  if (!body?.success || !Array.isArray(body?.data?.slots)) {
    throw new Error(`Failed to load slots: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.data.slots;
}

function buildPayload({ isoDate, slotId, index, companyOnly }) {
  const qty = QUANTITIES[index % QUANTITIES.length];
  const raising = companyOnly ? false : index % 2 === 0;
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const mobile = String(9823801000 + MOBILE_OFFSET + index);

  const payload = {
    name: `${first} Chaudhari ${index + 1}`,
    village: CONFIG.village,
    taluka: CONFIG.taluka,
    state: CONFIG.state,
    district: CONFIG.district,
    stateName: CONFIG.state,
    districtName: CONFIG.district,
    talukaName: CONFIG.taluka,
    mobileNumber: mobile,
    typeOfPlants: "",
    numberOfPlants: qty,
    rate: CONFIG.rate,
    paymentStatus: "not paid",
    salesPerson: CONFIG.salesPerson,
    orderStatus: "ACCEPTED",
    plantName: CONFIG.plantName,
    plantSubtype: CONFIG.plantSubtype,
    bookingSlot: slotId,
    orderDate: toIsoDelivery(isoDate),
    deliveryDate: toIsoDelivery(isoDate),
    orderPaymentStatus: "PENDING",
    cavity: CONFIG.cavity,
    orderBookingDate: toIsoBooking(isoDate),
    orderRemarks: [`Local seed order ${isoDate}${companyOnly ? " (company)" : ""}`],
  };

  if (raising) {
    payload.sowingPlan = {
      seedSource: "RAISING",
      companySeedPackets: 0,
      raisingSeedPackets: 0,
      sowingNotes: "biyane shetkari denar aahe",
    };
  } else {
    payload.sowingPlan = {
      seedSource: "COMPANY",
      companySeedPackets: 0,
      raisingSeedPackets: 0,
      sowingNotes: "",
    };
  }

  return { payload, raising, qty };
}

async function createOrder(payload) {
  const res = await fetch(`${API_BASE_URL}/api/v1/farmer/createFarmer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok || body?.status === "Error" || body?.success === false) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body?.data?.order?.orderId ?? body?.data?.orderId ?? "?";
}

async function main() {
  console.log(`Fetching slots from ${API_BASE_URL} ...`);
  const slots = await fetchSlots();
  const dates = [...dateRange(START_DATE, END_DATE)];
  const mode = COMPANY_ONLY ? "COMPANY only" : "RAISING + COMPANY mix";
  console.log(`Planning ${dates.length} orders (${START_DATE} → ${END_DATE}, ${mode})`);

  let created = 0;
  let failed = 0;

  for (let i = 0; i < dates.length; i += 1) {
    const isoDate = dates[i];
    const slot = findSlotForDate(slots, isoDate);
    if (!slot) {
      console.error(`✗ ${isoDate}: no booking slot found`);
      failed += 1;
      continue;
    }

    const { payload, raising, qty } = buildPayload({
      isoDate,
      slotId: slot._id,
      index: i,
      companyOnly: COMPANY_ONLY,
    });

    const label = `${isoDate} slot=${slot.startDay} qty=${qty} ${raising ? "RAISING" : "COMPANY"}`;
    if (DRY_RUN) {
      console.log(`[dry-run] ${label}`);
      created += 1;
      continue;
    }

    try {
      const orderId = await createOrder(payload);
      console.log(`✓ ${label} → orderId=${orderId}`);
      created += 1;
    } catch (err) {
      console.error(`✗ ${label} → ${err.message}`);
      failed += 1;
    }
  }

  console.log(`Done. created=${created}, failed=${failed}${DRY_RUN ? " (dry-run)" : ""}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
