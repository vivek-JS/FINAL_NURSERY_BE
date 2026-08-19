/**
 * Dry-run: sowing diary sheet vs PROD orders (Impact focus · 18 ready days).
 * Ignores packet / warehouse stock. Simulates direct-sow: plants → ready slot,
 * mark linked orders with deliveryDate = readyDate (explicit link only).
 *
 *   node scripts/dry-run-sowing-diary-impact.mjs
 *   node scripts/dry-run-sowing-diary-impact.mjs --year 2025
 *   node scripts/dry-run-sowing-diary-impact.mjs --variety Impact
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import Product from "../models/product.model.js";
import "../models/farmer.model.js";
import {
  addDays,
  fmtDDMMYYYY,
  findSlotByPlantReadyDate,
  resolveCmsReadyDays,
} from "../controllers/sowingSlotReadyHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const READY_DAYS = 18;
const yearArg = process.argv.find((a) => a.startsWith("--year="));
const YEAR = yearArg ? parseInt(yearArg.split("=")[1], 10) : 2026;
const varietyFilter = (() => {
  const i = process.argv.indexOf("--variety");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

/** Parse diary date like 5-Jul, 21-Jul, 3-Aug */
function parseDiaryDate(token) {
  const m = String(token || "")
    .trim()
    .match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (!m) return null;
  const months = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };
  const mon = months[m[2].toLowerCase()];
  if (mon == null) return null;
  return new Date(YEAR, mon, parseInt(m[1], 10), 12, 0, 0, 0);
}

function isFarmerSeed(note) {
  return /farmar|farmer|faramr/i.test(String(note || ""));
}

/**
 * Sowing diary rows transcribed from sheet (Jul–Aug).
 * variety names normalized later against CMS.
 */
const DIARY_ROWS = [
  { sow: "5-Jul", variety: "Melody", qty: 58590, pkt: null, lot: null, note: "Farmar Seed" },
  { sow: "9-Jul", variety: "Melody", qty: 58590, pkt: null, lot: null, note: "Farmar Seed" },
  { sow: "21-Jul", variety: "Melody", qty: 20412, pkt: null, lot: null, note: "Farmar Seed" },
  { sow: "21-Jul", variety: "Impact", qty: 21546, pkt: 21, lot: "37529301004" },
  { sow: "25-Jul", variety: "Impact", qty: 22932, pkt: 23, lot: "37438001004+35472501004" },
  { sow: "27-Jul", variety: "Melody", qty: 10017, pkt: null, lot: null, note: "Farmar seed" },
  { sow: "27-Jul", variety: "Melody", qty: 22176, pkt: null, lot: null, note: "Farmar seed" },
  { sow: "28-Jul", variety: "Impact", qty: 15750, pkt: 16, lot: "35438001004" },
  { sow: "28-Jul", variety: "Bhujang+", qty: 10458, pkt: null, lot: null, note: "Farmar seed" },
  { sow: "28-Jul", variety: "Shivaji", qty: 105336, pkt: null, lot: null, note: "Farmar seed" },
  { sow: "29-Jul", variety: "Melody", qty: 27342, pkt: null, lot: null, note: "faramr seed" },
  { sow: "29-Jul", variety: "Kargil", qty: 177030, pkt: null, lot: null, note: "Farmar seed" },
  { sow: "29-Jul", variety: "Melody", qty: 18522, pkt: null, lot: null, note: "faramr seed" },
  { sow: "29-Jul", variety: "Melody", qty: 17514, pkt: null, lot: null, note: "faramr seed" },
  { sow: "30-Jul", variety: "Impact", qty: 15237, pkt: 15, lot: "37437701004", note: "farmar" },
  { sow: "30-Jul", variety: "Melody", qty: 13482, pkt: null, lot: null, note: "farmar seed" },
  { sow: "2-Aug", variety: "Simbha", qty: 42960, pkt: null, lot: null, note: "re sowing 20 ani baki order" },
  { sow: "3-Aug", variety: "Impact", qty: 15750, pkt: 16, lot: "37438001004" },
  { sow: "4-Aug", variety: "Singham", qty: 46620, pkt: null, lot: null, note: "re sowing" },
  { sow: "9-Aug", variety: "Melody", qty: 17262, pkt: null, lot: null, note: "farmar seed" },
  { sow: "9-Aug", variety: "Bhujang+", qty: 17262, pkt: null, lot: null, note: "farmar seed" },
  { sow: "11-Aug", variety: "Melody", qty: 11313, pkt: null, lot: null, note: "farmar seed" },
  { sow: "12-Aug", variety: "Melody", qty: 11466, pkt: null, lot: null, note: "farmar seed" },
  { sow: "16-Aug", variety: "Impact", qty: 11214, pkt: 10, lot: "37593601004" },
  { sow: "16-Aug", variety: "Bhujang+", qty: 9576, pkt: null, lot: null, note: "Farmar seed" },
];

function uri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing in FINAL_NURSERY_BE/.env");
  return url;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9+]/g, "");
}

async function resolvePlantSubtype(varietyName, plantDocs) {
  const want = norm(varietyName);
  for (const plant of plantDocs) {
    if (!plant.sowingAllowed) continue;
    const pName = norm(plant.name);
    if (pName === want || pName.includes(want) || want.includes(pName)) {
      const st = (plant.subtypes || []).find((s) => norm(s.name) === want);
      if (st) return { plant, subtype: st, match: "plant+subtype same name" };
      if (plant.subtypes?.length === 1) {
        return { plant, subtype: plant.subtypes[0], match: "single subtype" };
      }
      return { plant, subtype: null, match: "plant found, subtype ambiguous" };
    }
    for (const st of plant.subtypes || []) {
      if (norm(st.name) === want) {
        return { plant, subtype: st, match: "subtype name" };
      }
    }
  }
  return null;
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
  // IST calendar day (stored delivery dates are often IST midnight as prior UTC evening)
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const start = new Date(Date.UTC(yyyy, mm, dd, 0, 0, 0, 0) - IST_OFFSET_MS);
  const end = new Date(Date.UTC(yyyy, mm, dd, 23, 59, 59, 999) - IST_OFFSET_MS);
  return { start, end };
}

async function ordersForReadyDate(plantId, subtypeId, readyStr) {
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
  const unsowed = all.filter((o) => o.sowingDone !== true);
  return { all, unsowed };
}

async function simulateSowRow(row, ctx) {
  const sowDate = parseDiaryDate(row.sow);
  if (!sowDate) return { ...row, error: `Bad sow date: ${row.sow}` };

  const readyDate = addDays(sowDate, READY_DAYS);
  const readyStr = fmtDDMMYYYY(readyDate);
  const farmerSeed = isFarmerSeed(row.note);
  const seedSource = farmerSeed ? "RAISING" : "COMPANY";

  const resolved = await resolvePlantSubtype(row.variety, ctx.plants);
  if (!resolved) {
    return {
      ...row,
      sowDate: fmtDDMMYYYY(sowDate),
      readyStr,
      error: `No sowing-allowed plant/subtype match for "${row.variety}"`,
    };
  }
  if (!resolved.subtype) {
    return {
      ...row,
      sowDate: fmtDDMMYYYY(sowDate),
      readyStr,
      plantName: resolved.plant.name,
      error: `Plant "${resolved.plant.name}" found but subtype unclear — pick manually`,
      subtypes: (resolved.plant.subtypes || []).map((s) => s.name),
    };
  }

  const plantId = resolved.plant._id;
  const subtypeId = resolved.subtype._id;
  const cmsReady = await resolveCmsReadyDays(plantId, subtypeId);
  const slot = await findSlotByPlantReadyDate(plantId, subtypeId, readyStr);

  const product = await Product.findOne({
    plantId,
    subtypeId,
    category: { $regex: /^seeds$/i },
    isActive: true,
  })
    .select("_id name code conversionFactor")
    .lean();

  const { all: ordersAll, unsowed: orders } = await ordersForReadyDate(
    plantId,
    subtypeId,
    readyStr
  );
  const orderNeed = orders.reduce((s, o) => s + orderPlants(o), 0);
  const orderNeedAll = ordersAll.reduce((s, o) => s + orderPlants(o), 0);
  const plantsSowed = Number(row.qty) || 0;
  const excess = Math.max(0, plantsSowed - orderNeed);
  const shortfall = Math.max(0, orderNeed - plantsSowed);

  const raisingOrders = orders.filter((o) => {
    const src = String(o.sowingPlan?.seedSource || "COMPANY").toUpperCase();
    return src === "RAISING" || src === "MIXED" || Number(o.sowingPlan?.raisingSeedPackets) > 0;
  });
  const companyOrders = orders.filter((o) => !raisingOrders.includes(o));

  return {
    variety: row.variety,
    sow: row.sow,
    sowDate: fmtDDMMYYYY(sowDate),
    readyStr,
    readyDaysUsed: READY_DAYS,
    cmsReadyDays: cmsReady,
    cmsMatchesDiary: cmsReady === READY_DAYS,
    seedSource,
    farmerSeedNote: row.note || "",
    lot: row.lot || "—",
    pkt: row.pkt ?? "—",
    plantsSowed,
    plantName: resolved.plant.name,
    subtypeName: resolved.subtype.name,
    plantId: String(plantId),
    subtypeId: String(subtypeId),
    match: resolved.match,
    slotFound: Boolean(slot?.slotId),
    slotLabel: slot?.startDay
      ? slot.endDay && slot.startDay !== slot.endDay
        ? `${slot.startDay} → ${slot.endDay}`
        : slot.startDay
      : "—",
    productAttached: Boolean(product?._id),
    productName: product?.name || "— NO SEED PRODUCT —",
    productCode: product?.code || "",
    conversionFactor: product?.conversionFactor ?? null,
    ordersOnReadyDay: orders.length,
    ordersOnReadyDayAll: ordersAll.length,
    orderPlantsOnReadyDay: orderNeed,
    orderPlantsOnReadyDayAll: orderNeedAll,
    alreadySowedOnDay: ordersAll.filter((o) => o.sowingDone === true).map((o) => ({
      orderNumber: o.orderId,
      plants: orderPlants(o),
    })),
    wouldMarkOrders: orders.map((o) => ({
      orderNumber: o.orderId,
      plants: orderPlants(o),
      seedSource: o.sowingPlan?.seedSource || "COMPANY",
      raisingCollected: Boolean(o.sowingPlan?.raisingIntakeCollected),
      farmer: o.farmer?.name || o.name || "",
    })),
    raisingOrderCount: raisingOrders.length,
    companyOrderCount: companyOrders.length,
    excessPlants: excess,
    shortfallPlants: shortfall,
    error: null,
  };
}

async function main() {
  console.log("=== DRY RUN — Sowing diary vs PROD orders ===");
  console.log(`Year: ${YEAR} · Ready days (diary): ${READY_DAYS}`);
  console.log("Logic: sow + 18d → ready slot · mark orders with deliveryDate = ready (linked only)");
  console.log("Packet / warehouse stock: IGNORED\n");

  await mongoose.connect(uri());

  const plants = await PlantCms.find({ sowingAllowed: true })
    .select("name subtypes sowingAllowed")
    .lean();

  console.log(`Sowing-allowed plants on prod: ${plants.length}\n`);

  const rows = varietyFilter
    ? DIARY_ROWS.filter(
        (r) => norm(r.variety) === norm(varietyFilter) || norm(r.variety).includes(norm(varietyFilter))
      )
    : DIARY_ROWS;

  const results = [];
  for (const row of rows) {
    results.push(await simulateSowRow(row, { plants }));
  }

  const impact = results.filter((r) => norm(r.variety) === "impact");
  const others = results.filter((r) => norm(r.variety) !== "impact");

  function printBlock(title, list) {
    console.log(`\n${"=".repeat(72)}`);
    console.log(title);
    console.log("=".repeat(72));
    for (const r of list) {
      if (r.error && !r.plantName) {
        console.log(`\n✗ ${r.variety} · sow ${r.sow} → ${r.error}`);
        continue;
      }
      if (r.error) {
        console.log(`\n⚠ ${r.variety} · sow ${r.sow} · ${r.plantName} — ${r.error}`);
        if (r.subtypes) console.log(`  Subtypes: ${r.subtypes.join(", ")}`);
        continue;
      }
      const prodFlag = r.productAttached ? "✓ product" : "✗ NO SEED PRODUCT";
      const slotFlag = r.slotFound ? `✓ slot ${r.slotLabel}` : "✗ NO SLOT for ready date";
      const cmsFlag = r.cmsMatchesDiary
        ? "✓ CMS ready days = 18"
        : `⚠ CMS ready days = ${r.cmsReadyDays} (diary uses 18)`;

      console.log(`\n${r.variety} · sow ${r.sowDate} (${r.sow}) → ready ${r.readyStr} (+${r.readyDaysUsed}d)`);
      console.log(`  ${r.plantName} / ${r.subtypeName} · seed: ${r.seedSource}${r.farmerSeedNote ? ` (${r.farmerSeedNote})` : ""}`);
      console.log(`  Lot ${r.lot} · pkt ${r.pkt} (ignored for stock) · sowed ${fmt(r.plantsSowed)} plants`);
      console.log(`  ${prodFlag}${r.productName !== "— NO SEED PRODUCT —" ? `: ${r.productName}` : ""}`);
      console.log(`  ${slotFlag} · ${cmsFlag}`);

      if (r.ordersOnReadyDay === 0 && (r.ordersOnReadyDayAll || 0) === 0) {
        console.log(`  Orders on ready day ${r.readyStr}: NONE → all ${fmt(r.plantsSowed)} = EXCESS`);
      } else {
        if ((r.alreadySowedOnDay || []).length) {
          console.log(
            `  Already sowingDone on ${r.readyStr}: ${r.alreadySowedOnDay.map((o) => `#${o.orderNumber} (${fmt(o.plants)})`).join(", ")}`
          );
        }
        console.log(
          `  Would mark (unsowed) on ${r.readyStr}: ${r.ordersOnReadyDay} orders (${fmt(r.orderPlantsOnReadyDay)} plants) · raising ${r.raisingOrderCount} · company ${r.companyOrderCount}`
        );
        for (const o of r.wouldMarkOrders) {
          const raiseWarn =
            o.seedSource === "RAISING" && !o.raisingCollected ? " ⚠ raising NOT collected" : "";
          console.log(
            `    #${o.orderNumber} · ${fmt(o.plants)} · ${o.seedSource}${raiseWarn} · ${o.farmer}`
          );
        }
        if (r.excessPlants > 0) {
          console.log(`  → EXCESS after cover: ${fmt(r.excessPlants)} plants (saleable on slot)`);
        }
        if (r.shortfallPlants > 0) {
          console.log(`  → SHORTFALL: orders need ${fmt(r.shortfallPlants)} more plants than sowed`);
        }
      }
    }
  }

  printBlock("IMPACT — detail", impact.length ? impact : results.filter((r) => norm(r.variety).includes("impact")));
  if (!varietyFilter) {
    printBlock("ALL OTHER VARIETIES — summary", others);
  }

  console.log("\n\n--- SUMMARY ---");
  const noProduct = results.filter((r) => !r.error && r.productAttached === false);
  const noSlot = results.filter((r) => !r.error && r.slotFound === false);
  const noPlant = results.filter((r) => r.error && !r.plantName);
  const cmsMismatch = results.filter((r) => !r.error && !r.cmsMatchesDiary);

  console.log(`Rows simulated: ${results.length}`);
  console.log(`No plant match: ${noPlant.length}`);
  console.log(`No seed product: ${noProduct.length}${noProduct.length ? " → " + [...new Set(noProduct.map((r) => r.variety))].join(", ") : ""}`);
  console.log(`No calendar slot: ${noSlot.length}`);
  console.log(`CMS ready days ≠ 18: ${cmsMismatch.length}`);

  const totalExcess = results.reduce((s, r) => s + (r.excessPlants || 0), 0);
  const totalSowed = results.reduce((s, r) => s + (r.plantsSowed || 0), 0);
  console.log(`Total plants sowed (sheet): ${fmt(totalSowed)}`);
  console.log(`Total excess if each row links only same-day delivery orders: ${fmt(totalExcess)}`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
