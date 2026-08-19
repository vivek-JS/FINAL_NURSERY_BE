/**
 * Map every sowing-diary row → PROD plant / subtype / CMS plantReadyDays / seed product.
 *
 *   node scripts/sowing-diary-plant-lookup.mjs
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import Product from "../models/product.model.js";
import { addDays, fmtDDMMYYYY } from "../controllers/sowingSlotReadyHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const DIARY_READY_DAYS = 18;

/** Diary spelling → CMS subtype name on prod */
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

/** Full diary sheet (sow · variety · qty · note). Ready = sow + 18d unless ready col given. */
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

function parseDiaryDate(token, year = 2026) {
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
  return new Date(year, mon, parseInt(m[1], 10), 12, 0, 0, 0);
}

function resolveSubtype(canonical, plants) {
  const want = norm(canonical);
  for (const plant of plants) {
    for (const st of plant.subtypes || []) {
      if (norm(st.name) === want) {
        return { plant, subtype: st, match: "exact subtype" };
      }
    }
  }
  for (const plant of plants) {
    for (const st of plant.subtypes || []) {
      const sn = norm(st.name);
      if (sn.includes(want) || want.includes(sn)) {
        return { plant, subtype: st, match: "fuzzy subtype" };
      }
    }
  }
  return null;
}

function pad(s, n) {
  return String(s ?? "").slice(0, n).padEnd(n);
}

async function main() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing in FINAL_NURSERY_BE/.env");

  await mongoose.connect(url);

  const plants = await PlantCms.find({})
    .select("name sowingAllowed subtypes.name subtypes.plantReadyDays subtypes._id")
    .lean();

  const sowingPlants = plants.filter((p) => p.sowingAllowed);

  console.log("=== Sowing diary → PROD plant / subtype / plantReadyDays ===\n");
  console.log(
    `${pad("#", 3)} ${pad("Sow", 8)} ${pad("Diary ready", 12)} ${pad("Diary variety", 14)} ${pad("CMS plant", 12)} ${pad("CMS subtype", 16)} ${pad("CMS days", 8)} ${pad("Diary", 6)} ${pad("Match", 12)} Seed product`
  );
  console.log("-".repeat(120));

  const unique = new Map();
  let i = 0;

  for (const row of DIARY_ROWS) {
    i += 1;
    const sowDate = parseDiaryDate(row.sow);
    const readyFromSheet = row.ready ? parseDiaryDate(row.ready) : null;
    const readyCalc = sowDate ? addDays(sowDate, DIARY_READY_DAYS) : null;
    const readyStr = readyFromSheet
      ? fmtDDMMYYYY(readyFromSheet)
      : readyCalc
        ? fmtDDMMYYYY(readyCalc)
        : "—";

    const canonical = canonicalVariety(row.variety);
    const resolved = resolveSubtype(canonical, sowingPlants);

    let cmsDays = "—";
    let plantName = "— NOT FOUND —";
    let subtypeName = "—";
    let match = "—";
    let productLabel = "— NO PRODUCT —";
    let daysOk = "—";

    if (resolved) {
      plantName = resolved.plant.name;
      subtypeName = resolved.subtype.name;
      cmsDays = Number(resolved.subtype.plantReadyDays) || 0;
      match = resolved.match;
      daysOk = cmsDays === DIARY_READY_DAYS ? "✓ 18" : `≠ ${cmsDays}`;

      const product = await Product.findOne({
        plantId: resolved.plant._id,
        subtypeId: resolved.subtype._id,
        category: { $regex: /^seeds$/i },
        isActive: true,
      })
        .select("name code")
        .lean();
      productLabel = product ? `${product.name}${product.code ? ` (${product.code})` : ""}` : "— NO PRODUCT —";
    }

    const farmer = /farmar|farmer|faramr/i.test(row.note || "") ? "RAISING" : "COMPANY";
    const noteShort = row.note ? ` · ${row.note.slice(0, 20)}` : "";

    console.log(
      `${pad(i, 3)} ${pad(row.sow, 8)} ${pad(readyStr, 12)} ${pad(row.variety, 14)} ${pad(plantName, 12)} ${pad(subtypeName, 16)} ${pad(String(cmsDays), 8)} ${pad(daysOk, 6)} ${pad(match, 12)} ${productLabel}${noteShort}`
    );

    const ukey = norm(canonical);
    if (!unique.has(ukey)) {
      unique.set(ukey, {
        diary: row.variety,
        canonical,
        plantName,
        subtypeName,
        cmsDays,
        daysOk,
        productLabel,
        found: Boolean(resolved),
      });
    }
  }

  console.log("\n\n=== Unique varieties (deduped) ===\n");
  console.log(
    `${pad("Diary name", 16)} ${pad("→ CMS subtype", 18)} ${pad("Plant", 12)} ${pad("readyDays", 10)} ${pad("vs diary 18", 12)} Product`
  );
  console.log("-".repeat(90));
  for (const u of unique.values()) {
    console.log(
      `${pad(u.diary, 16)} ${pad(u.canonical, 18)} ${pad(u.plantName, 12)} ${pad(String(u.cmsDays), 10)} ${pad(u.daysOk, 12)} ${u.productLabel}`
    );
  }

  const notFound = [...unique.values()].filter((u) => !u.found);
  const daysMismatch = [...unique.values()].filter(
    (u) => u.found && u.cmsDays !== DIARY_READY_DAYS
  );
  const noProduct = [...unique.values()].filter(
    (u) => u.found && u.productLabel.includes("NO PRODUCT")
  );

  console.log("\n--- Checks ---");
  console.log(`Total diary rows: ${DIARY_ROWS.length}`);
  console.log(`Unique varieties: ${unique.size}`);
  console.log(`Not found in CMS: ${notFound.length}${notFound.length ? " → " + notFound.map((u) => u.diary).join(", ") : ""}`);
  console.log(`CMS readyDays ≠ 18: ${daysMismatch.length}${daysMismatch.length ? " → " + daysMismatch.map((u) => `${u.canonical}=${u.cmsDays}`).join(", ") : ""}`);
  console.log(`No seed product: ${noProduct.length}${noProduct.length ? " → " + noProduct.map((u) => u.canonical).join(", ") : ""}`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
