/**
 * Full dry-run: every diary row → CMS match, slot, product, orders impacted, excess/shortfall.
 * Packet stock ignored. Marks simulation = unsowed orders with deliveryDate on ready day (IST).
 *
 *   node scripts/sowing-diary-full-dry-run.mjs
 *   node scripts/sowing-diary-full-dry-run.mjs --year=2026
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import Order from "../models/order.model.js";
import Product from "../models/product.model.js";
import "../models/farmer.model.js";
import {
  addDays,
  fmtDDMMYYYY,
  findSlotByPlantReadyDate,
} from "../controllers/sowingSlotReadyHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const DIARY_READY_DAYS = 18;
const yearArg = process.argv.find((a) => a.startsWith("--year="));
const YEAR = yearArg ? parseInt(yearArg.split("=")[1], 10) : 2026;

const ALIASES = {
  impact: "Impact",
  melody: "Melody",
  simbha: "SImbha",
  bhujang: "Bahubali Plus",
  "bhujang+": "Bahubali Plus",
  kargil: "Kargil Plus",
  redking: "Redking",
  "red king": "Redking",
  singham: "Singham",
  vijay: "Vijay",
  shivaji: "Shivaji",
};

const DIARY_ROWS = [
  { sow: "5-Jul", variety: "Melody", qty: 58590, note: "" },
  { sow: "9-Jul", variety: "Melody", qty: null, note: "Farmar Seed", ready: "27-Jul" },
  { sow: "10-Jul", variety: "Singham", qty: null, note: "" },
  { sow: "11-Jul", variety: "Vijay", qty: null, note: "" },
  { sow: "13-Jul", variety: "Melody", qty: null, note: "" },
  { sow: "19-Jul", variety: "Simbha", qty: null, note: "" },
  { sow: "20-Jul", variety: "Singham", qty: null, note: "" },
  { sow: "20-Jul", variety: "Simbha", qty: null, note: "" },
  { sow: "21-Jul", variety: "Melody", qty: 20412, note: "Farmar Seed" },
  { sow: "21-Jul", variety: "Impact", qty: 21546, note: "" },
  { sow: "22-Jul", variety: "Melody", qty: null, note: "" },
  { sow: "22-Jul", variety: "Vijay", qty: null, note: "" },
  { sow: "24-Jul", variety: "Melody", qty: null, note: "" },
  { sow: "24-Jul", variety: "Vijay", qty: null, note: "" },
  { sow: "25-Jul", variety: "Impact", qty: 22932, note: "" },
  { sow: "25-Jul", variety: "Simbha", qty: null, note: "" },
  { sow: "27-Jul", variety: "Simbha", qty: null, note: "" },
  { sow: "27-Jul", variety: "Melody", qty: 10017, note: "Farmar seed" },
  { sow: "27-Jul", variety: "Melody", qty: 22176, note: "Farmar seed" },
  { sow: "27-Jul", variety: "Singham", qty: null, note: "" },
  { sow: "28-Jul", variety: "Impact", qty: 15750, note: "" },
  { sow: "28-Jul", variety: "Bhujang+", qty: 10458, note: "Farmar seed" },
  { sow: "28-Jul", variety: "Shivaji", qty: 105336, note: "Farmar seed" },
  { sow: "28-Jul", variety: "Red King", qty: null, note: "" },
  { sow: "29-Jul", variety: "Melody", qty: 27342, note: "faramr seed" },
  { sow: "29-Jul", variety: "Kargil", qty: 177030, note: "Farmar seed" },
  { sow: "29-Jul", variety: "Melody", qty: 18522, note: "faramr seed" },
  { sow: "29-Jul", variety: "Melody", qty: 17514, note: "faramr seed" },
  { sow: "30-Jul", variety: "Melody", qty: 13482, note: "farmar seed" },
  { sow: "30-Jul", variety: "Impact", qty: 15237, note: "farmar" },
  { sow: "2-Aug", variety: "Simbha", qty: 42960, note: "re sowing 20 ani baki order" },
  { sow: "3-Aug", variety: "Impact", qty: 15750, note: "" },
  { sow: "4-Aug", variety: "Singham", qty: 46620, note: "re sowing" },
  { sow: "9-Aug", variety: "Melody", qty: 17262, note: "farmar seed" },
  { sow: "9-Aug", variety: "Bhujang+", qty: 17262, note: "farmar seed" },
  { sow: "11-Aug", variety: "Melody", qty: 11313, note: "farmar seed" },
  { sow: "12-Aug", variety: "Melody", qty: 11466, note: "farmar seed" },
  { sow: "16-Aug", variety: "Impact", qty: 11214, note: "" },
  { sow: "16-Aug", variety: "Bhujang+", qty: 9576, note: "Farmar seed" },
];

const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9+ ]/g, "");
}

function canonicalVariety(name) {
  const n = norm(name);
  if (ALIASES[n]) return ALIASES[n];
  const noPlus = n.replace(/\+/g, "").trim();
  if (ALIASES[noPlus]) return ALIASES[noPlus];
  return String(name || "").trim();
}

function parseDiaryDate(token) {
  const m = String(token || "")
    .trim()
    .match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (!m) return null;
  const months = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const mon = months[m[2].toLowerCase()];
  if (mon == null) return null;
  return new Date(YEAR, mon, parseInt(m[1], 10), 12, 0, 0, 0);
}

function isFarmerSeed(note) {
  return /farmar|farmer|faramr/i.test(String(note || ""));
}

function orderPlants(o) {
  return (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0);
}

function dayRangeFromDdMmYyyy(readyStr) {
  const m = String(readyStr || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const dd = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10) - 1;
  const yyyy = parseInt(m[3], 10);
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const start = new Date(Date.UTC(yyyy, mm, dd, 0, 0, 0, 0) - IST_OFFSET_MS);
  const end = new Date(Date.UTC(yyyy, mm, dd, 23, 59, 59, 999) - IST_OFFSET_MS);
  return { start, end };
}

function resolveSubtype(canonical, plants) {
  const want = norm(canonical);
  for (const plant of plants) {
    if (!plant.sowingAllowed) continue;
    for (const st of plant.subtypes || []) {
      if (norm(st.name) === want) {
        return { plant, subtype: st, match: "exact" };
      }
    }
  }
  for (const plant of plants) {
    if (!plant.sowingAllowed) continue;
    for (const st of plant.subtypes || []) {
      const sn = norm(st.name);
      if (sn.includes(want) || want.includes(sn)) {
        return { plant, subtype: st, match: "fuzzy" };
      }
    }
  }
  return null;
}

async function fetchOrders(plantId, subtypeId, readyStr) {
  const range = dayRangeFromDdMmYyyy(readyStr);
  if (!range) return { all: [], unsowed: [] };
  const all = await Order.find({
    plantName: plantId,
    plantSubtype: subtypeId,
    deliveryDate: { $gte: range.start, $lte: range.end },
    orderStatus: {
      $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"],
    },
  })
    .select(
      "orderId numberOfPlants additionalPlants deliveryDate sowingPlan sowingDone orderStatus farmer name"
    )
    .populate("farmer", "name mobileNumber")
    .sort({ orderId: 1 })
    .lean();
  return { all, unsowed: all.filter((o) => o.sowingDone !== true) };
}

function fmtOrderLine(o) {
  const src = String(o.sowingPlan?.seedSource || "COMPANY").toUpperCase();
  const collected = o.sowingPlan?.raisingIntakeCollected ? "collected" : "NOT collected";
  const raise =
    src === "RAISING" || src === "MIXED" ? ` · raising ${collected}` : "";
  const farmer = o.farmer?.name || o.name || "—";
  const del = o.deliveryDate ? new Date(o.deliveryDate).toISOString().slice(0, 10) : "—";
  return `    #${o.orderId} · ${fmt(orderPlants(o))} plants · ${src}${raise} · ${farmer} · del ${del} · ${o.orderStatus}${o.sowingDone ? " · already sowed" : " · WOULD MARK"}`;
}

async function simulateRow(idx, row, sowingPlants) {
  const sowDate = parseDiaryDate(row.sow);
  const readySheet = row.ready ? parseDiaryDate(row.ready) : null;
  const readyDiary = sowDate ? addDays(sowDate, DIARY_READY_DAYS) : null;
  const readyForOrders = readySheet || readyDiary;
  const readyStr = readyForOrders ? fmtDDMMYYYY(readyForOrders) : "—";

  const canonical = canonicalVariety(row.variety);
  const resolved = resolveSubtype(canonical, sowingPlants);
  const seedSource = isFarmerSeed(row.note) ? "RAISING" : "COMPANY";
  const plantsSowed = Number(row.qty) || 0;

  const out = {
    idx,
    sow: row.sow,
    variety: row.variety,
    canonical,
    qty: row.qty,
    note: row.note || "",
    seedSource,
    sowDate: sowDate ? fmtDDMMYYYY(sowDate) : "—",
    readyStr,
  };

  if (!resolved) {
    out.status = "NO_MATCH";
    return out;
  }

  const { plant, subtype } = resolved;
  const cmsDays = Number(subtype.plantReadyDays) || 0;
  const readySlotDate = sowDate ? addDays(sowDate, cmsDays) : null;
  const readySlotStr = readySlotDate ? fmtDDMMYYYY(readySlotDate) : "—";

  out.plant = plant.name;
  out.subtype = subtype.name;
  out.cmsDays = cmsDays;
  out.readySlotStr = readySlotStr;
  out.slotDaysMatchDiary = cmsDays === DIARY_READY_DAYS;

  const [slotDiary, slotCms, product, orderPack] = await Promise.all([
    findSlotByPlantReadyDate(plant._id, subtype._id, readyStr),
    cmsDays !== DIARY_READY_DAYS && readySlotStr !== readyStr
      ? findSlotByPlantReadyDate(plant._id, subtype._id, readySlotStr)
      : Promise.resolve(null),
    Product.findOne({
      plantId: plant._id,
      subtypeId: subtype._id,
      category: { $regex: /^seeds$/i },
      isActive: true,
    })
      .select("name code conversionFactor")
      .lean(),
    fetchOrders(plant._id, subtype._id, readyStr),
  ]);

  const slot = slotDiary?.slotId ? slotDiary : slotCms;
  out.product = product?.name || null;
  out.productCode = product?.code || null;
  out.slotFound = Boolean(slot?.slotId);
  out.slotLabel = slot?.startDay
    ? slot.endDay && slot.startDay !== slot.endDay
      ? `${slot.startDay} → ${slot.endDay}`
      : slot.startDay
    : "—";
  if (readySlotStr !== readyStr) {
    out.slotNote = `CMS uses ready ${readySlotStr} (not diary ${readyStr})`;
  }

  const { all, unsowed } = orderPack;
  const needUnsowed = unsowed.reduce((s, o) => s + orderPlants(o), 0);
  const needAll = all.reduce((s, o) => s + orderPlants(o), 0);

  out.ordersTotal = all.length;
  out.ordersUnsowed = unsowed.length;
  out.plantsUnsowed = needUnsowed;
  out.plantsAll = needAll;
  out.alreadySowed = all.filter((o) => o.sowingDone === true);
  out.wouldMark = unsowed;
  out.excess = plantsSowed > 0 ? Math.max(0, plantsSowed - needUnsowed) : null;
  out.shortfall = plantsSowed > 0 ? Math.max(0, needUnsowed - plantsSowed) : null;
  out.raisingUnsowed = unsowed.filter((o) => {
    const s = String(o.sowingPlan?.seedSource || "COMPANY").toUpperCase();
    return s === "RAISING" || s === "MIXED";
  }).length;

  if (!product) out.warnings = (out.warnings || []).concat("NO_SEED_PRODUCT");
  if (!out.slotFound) out.warnings = (out.warnings || []).concat("NO_SLOT");
  if (!out.slotDaysMatchDiary)
    out.warnings = (out.warnings || []).concat(`CMS_DAYS_${cmsDays}_NOT_18`);
  for (const o of unsowed) {
    const s = String(o.sowingPlan?.seedSource || "COMPANY").toUpperCase();
    if ((s === "RAISING" || s === "MIXED") && !o.sowingPlan?.raisingIntakeCollected) {
      out.warnings = (out.warnings || []).concat(`RAISING_NOT_COLLECTED_#${o.orderId}`);
    }
  }
  if (seedSource === "RAISING" && out.wouldMark.some((o) => !o.sowingPlan?.raisingIntakeCollected)) {
    out.warnings = (out.warnings || []).concat("SOW_RAISING_BUT_INTAKE_MISSING");
  }

  out.status = "OK";
  return out;
}

function printRow(r) {
  console.log(`\n${"─".repeat(78)}`);
  console.log(`ROW ${r.idx} · ${r.variety} → ${r.canonical} · sow ${r.sow} (${r.sowDate})`);
  if (r.status === "NO_MATCH") {
    console.log(`  ✗ No CMS plant/subtype match`);
    return;
  }
  console.log(`  Plant/subtype: ${r.plant} / ${r.subtype} · CMS ready days: ${r.cmsDays}`);
  console.log(
    `  Diary ready (orders): ${r.readyStr} (+${DIARY_READY_DAYS}d) · Slot ready (CMS): ${r.readySlotStr}${r.slotNote ? ` · ${r.slotNote}` : ""}`
  );
  console.log(
    `  Sowed qty: ${r.qty != null ? fmt(r.qty) : "— (not in sheet)"} · Seed: ${r.seedSource}${r.note ? ` · ${r.note}` : ""}`
  );
  console.log(
    `  Product: ${r.product ? `✓ ${r.product} (${r.productCode || ""})` : "✗ NO SEED PRODUCT"} · Slot: ${r.slotFound ? `✓ ${r.slotLabel}` : "✗ missing"}`
  );

  if (r.alreadySowed?.length) {
    console.log(`  Already sowingDone on ${r.readyStr}:`);
    for (const o of r.alreadySowed) console.log(fmtOrderLine({ ...o, sowingDone: true }));
  }

  if (!r.wouldMark?.length) {
    console.log(`  Orders to mark on ${r.readyStr}: NONE`);
    if (r.qty != null && r.qty > 0) console.log(`  → All ${fmt(r.qty)} plants = EXCESS on slot`);
  } else {
    console.log(
      `  Would mark ${r.ordersUnsowed} order(s) · ${fmt(r.plantsUnsowed)} plants (${r.raisingUnsowed} raising):`
    );
    for (const o of r.wouldMark) console.log(fmtOrderLine(o));
    if (r.excess != null && r.excess > 0)
      console.log(`  → EXCESS: ${fmt(r.excess)} plants (saleable on slot)`);
    if (r.shortfall != null && r.shortfall > 0)
      console.log(`  → SHORTFALL: need ${fmt(r.shortfall)} more plants (still marks all linked in app)`);
  }

  if (r.warnings?.length) console.log(`  ⚠ ${[...new Set(r.warnings)].join(" · ")}`);
}

async function main() {
  console.log("=== FULL DRY RUN — Each diary row · orders · slot · product ===");
  console.log(`Year ${YEAR} · diary +18d for order match · packet stock ignored\n`);

  await mongoose.connect(process.env.PROD_MONGO_URL);

  const plants = await PlantCms.find({})
    .select("name sowingAllowed subtypes")
    .lean();
  const sowingPlants = plants.filter((p) => p.sowingAllowed);

  const results = [];
  for (let i = 0; i < DIARY_ROWS.length; i++) {
    results.push(await simulateRow(i + 1, DIARY_ROWS[i], sowingPlants));
  }

  for (const r of results) printRow(r);

  console.log(`\n${"=".repeat(78)}`);
  console.log("SUMMARY");
  console.log("=".repeat(78));
  const ok = results.filter((r) => r.status === "OK");
  const withOrders = ok.filter((r) => r.ordersUnsowed > 0);
  const withExcess = ok.filter((r) => r.excess > 0);
  const withShortfall = ok.filter((r) => r.shortfall > 0);
  const noProduct = ok.filter((r) => !r.product);
  const noMatch = results.filter((r) => r.status === "NO_MATCH");

  console.log(`Rows: ${DIARY_ROWS.length} · matched: ${ok.length} · no CMS match: ${noMatch.length}`);
  console.log(`Rows with unsowed orders on ready day: ${withOrders.length}`);
  console.log(`Rows with excess (qty known): ${withExcess.length}`);
  console.log(`Rows with shortfall: ${withShortfall.length}`);
  console.log(`Rows missing seed product: ${noProduct.length}`);

  console.log("\nCompact table:");
  console.log(
    "Row  Sow      Variety        Ready      Qty        Unsowed orders  Plants need  Excess     Shortfall  Warnings"
  );
  console.log("-".repeat(110));
  for (const r of results) {
    if (r.status === "NO_MATCH") {
      console.log(
        `${String(r.idx).padStart(3)}  ${r.sow.padEnd(8)} ${r.variety.padEnd(14)} —          —          —               —            —          —          NO MATCH`
      );
      continue;
    }
    const w = (r.warnings || []).slice(0, 2).join(";") || "—";
    console.log(
      `${String(r.idx).padStart(3)}  ${r.sow.padEnd(8)} ${r.variety.padEnd(14)} ${r.readyStr.padEnd(10)} ${(r.qty != null ? fmt(r.qty) : "—").padStart(10)} ${String(r.ordersUnsowed).padStart(15)} ${fmt(r.plantsUnsowed).padStart(12)} ${(r.excess != null ? fmt(r.excess) : "—").padStart(10)} ${(r.shortfall != null ? fmt(r.shortfall) : "—").padStart(10)} ${w}`
    );
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
