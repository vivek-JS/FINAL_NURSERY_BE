/**
 * Dry-run insert of sowing diary: subtype + ready-date slot for each row.
 * Lot No = batch. Packets are per-batch. Farmer seed = RAISING.
 *
 *   node scripts/sowing-diary-insert-dry-run.mjs
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import Product from "../models/product.model.js";
import {
  addDays,
  fmtDDMMYYYY,
  findSlotByPlantReadyDate,
} from "../controllers/sowingSlotReadyHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const READY_DAYS = 18;
const YEAR = 2026;

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

/** Each row: sow, variety, qty, raising, batches[{batch, pkt}] */
const ROWS = [
  { sow: "5-Jul", variety: "Melody", qty: 20916, raising: false, batches: [{ batch: "2600376", pkt: 2 }, { batch: "2601433", pkt: 15 }] },
  { sow: "9-Jul", variety: "Melody", qty: 58590, raising: true, batches: [{ batch: "2601433", pkt: 37 }, { batch: "2600354", pkt: 11 }] },
  { sow: "10-Jul", variety: "Singham", qty: 47250, raising: false, batches: [{ batch: "12-0925-325", pkt: 24 }, { batch: "R50-270-522/1/2", pkt: 20 }] },
  { sow: "11-Jul", variety: "Vijay", qty: 15498, raising: false, batches: [{ batch: "A02731", pkt: 13 }] },
  { sow: "13-Jul", variety: "Melody", qty: 13482, raising: false, batches: [{ batch: "2602506", pkt: 9 }, { batch: "2601433", pkt: 2 }] },
  { sow: "19-Jul", variety: "Simbha", qty: 63378, raising: false, batches: [{ batch: "21092374", pkt: 62 }] },
  { sow: "20-Jul", variety: "Singham", qty: 24318, raising: false, batches: [{ batch: "R50-270-522/1/2", pkt: 22 }] },
  { sow: "20-Jul", variety: "Simbha", qty: 7938, raising: false, batches: [{ batch: "21092374", pkt: 22 }] },
  { sow: "21-Jul", variety: "Melody", qty: 20412, raising: true, batches: [{ batch: "2602605", pkt: 15 }] },
  { sow: "21-Jul", variety: "Impact", qty: 21546, raising: false, batches: [{ batch: "37529301004", pkt: 21 }] },
  { sow: "22-Jul", variety: "Melody", qty: 20286, raising: false, batches: [{ batch: "2602506", pkt: 15 }] },
  { sow: "22-Jul", variety: "Vijay", qty: 20412, raising: false, batches: [{ batch: "A02731", pkt: 17 }] },
  { sow: "24-Jul", variety: "Melody", qty: 10080, raising: false, batches: [{ batch: "2602506", pkt: 6 }, { batch: "2602559", pkt: 2 }] },
  { sow: "24-Jul", variety: "Vijay", qty: 29106, raising: false, batches: [{ batch: "A02731", pkt: 24 }] },
  { sow: "25-Jul", variety: "Impact", qty: 22932, raising: false, batches: [{ batch: "37438001004", pkt: 21 }, { batch: "35472501004", pkt: 2 }] },
  { sow: "25-Jul", variety: "Simbha", qty: 40068, raising: false, batches: [{ batch: "0021092374", pkt: 10 }, { batch: "0021039884", pkt: 10 }, { batch: "0021399648", pkt: 13 }, { batch: "0021046327", pkt: 6 }] },
  { sow: "27-Jul", variety: "Simbha", qty: 18270, raising: false, batches: [{ batch: "21046327", pkt: 18 }] },
  { sow: "27-Jul", variety: "Melody", qty: 10017, raising: true, batches: [{ batch: "2601461", pkt: 8 }] },
  { sow: "27-Jul", variety: "Melody", qty: 22176, raising: true, batches: [{ batch: "2602506", pkt: 18 }] },
  { sow: "27-Jul", variety: "Melody", qty: 12348, raising: false, batches: [{ batch: "2602559", pkt: 9 }] },
  { sow: "27-Jul", variety: "Singham", qty: 20160, raising: false, batches: [{ batch: "R50270-522/1/2", pkt: 17 }] },
  { sow: "28-Jul", variety: "Impact", qty: 15750, raising: false, batches: [{ batch: "35438001004", pkt: 16 }] },
  { sow: "28-Jul", variety: "Bhujang+", qty: 10458, raising: true, batches: [{ batch: "SNX-2006", pkt: 8 }] },
  { sow: "28-Jul", variety: "Shivaji", qty: 105336, raising: true, batches: [{ batch: "25227", pkt: 80 }] },
  { sow: "28-Jul", variety: "Red King", qty: 47124, raising: true, batches: [{ batch: "GRB-JLN-261", pkt: 45 }] },
  { sow: "29-Jul", variety: "Melody", qty: 27342, raising: true, batches: [{ batch: "2601329", pkt: 20 }] },
  { sow: "29-Jul", variety: "Kargil", qty: 177030, raising: true, batches: [{ batch: "25221", pkt: 130 }] },
  { sow: "29-Jul", variety: "Melody", qty: 18522, raising: true, batches: [{ batch: "2601461", pkt: 15 }] },
  { sow: "29-Jul", variety: "Melody", qty: 17514, raising: true, batches: [{ batch: "2601461", pkt: 14 }] },
  { sow: "30-Jul", variety: "Melody", qty: 13482, raising: true, batches: [{ batch: "2601461", pkt: 3 }, { batch: "2602605", pkt: 7 }] },
  { sow: "30-Jul", variety: "Impact", qty: 15237, raising: true, batches: [{ batch: "37437701004", pkt: 15 }] },
  { sow: "2-Aug", variety: "Simbha", qty: 42960, raising: false, note: "re sowing 20 ani baki order", batches: [{ batch: "21050026", pkt: 43 }] },
  { sow: "3-Aug", variety: "Red King", qty: 29736, raising: false, batches: [{ batch: "GRB-JLN-261", pkt: 28 }] },
  { sow: "3-Aug", variety: "Impact", qty: 15750, raising: false, batches: [{ batch: "37438001004", pkt: 16 }] },
  { sow: "4-Aug", variety: "Singham", qty: 46620, raising: false, note: "re sowing", batches: [{ batch: "R50-270-522/1/2", pkt: 41 }] },
  { sow: "7-Aug", variety: "Red King", qty: 19040, raising: false, batches: [{ batch: "GRB-JLN-261", pkt: 17 }] },
  { sow: "9-Aug", variety: "Simbha", qty: 20160, raising: false, batches: [{ batch: "21050026", pkt: 20 }] },
  { sow: "9-Aug", variety: "Melody", qty: 34272, raising: false, batches: [{ batch: "2602569", pkt: 27 }] },
  { sow: "9-Aug", variety: "Melody", qty: 17262, raising: true, batches: [{ batch: "2601461", pkt: 14 }] },
  { sow: "9-Aug", variety: "Bhujang+", qty: 17262, raising: true, batches: [{ batch: "SNX-2008", pkt: 14 }] },
  { sow: "11-Aug", variety: "Melody", qty: 11313, raising: true, batches: [{ batch: "2602569", pkt: 9 }] },
  { sow: "12-Aug", variety: "Red King", qty: 7938, raising: false, batches: [{ batch: "GRB-JLN-261", pkt: 8 }] },
  { sow: "12-Aug", variety: "Melody", qty: 11466, raising: true, batches: [{ batch: "2602569", pkt: 9 }] },
  { sow: "16-Aug", variety: "Simbha", qty: 11844, raising: false, batches: [{ batch: "21050026", pkt: 11 }] },
  { sow: "16-Aug", variety: "Bhujang+", qty: 9576, raising: true, batches: [{ batch: "SNX-2031", pkt: 1.5 }] },
  { sow: "16-Aug", variety: "Melody", qty: 54180, raising: false, batches: [{ batch: "2602569", pkt: 43 }] },
  { sow: "16-Aug", variety: "Impact", qty: 11214, raising: false, batches: [{ batch: "37593601004", pkt: 10 }] },
  { sow: "16-Aug", variety: "Vijay", qty: 29106, raising: false, batches: [{ batch: "A02731", pkt: 25 }] },
  { sow: "17-Aug", variety: "Red King", qty: 75096, raising: false, batches: [{ batch: "GRB-JLN-261", pkt: 71 }] },
];

const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9+ ]/g, "");
}

function canonical(name) {
  const n = norm(name);
  if (ALIASES[n]) return ALIASES[n];
  const noPlus = n.replace(/\+/g, "").trim();
  if (ALIASES[noPlus]) return ALIASES[noPlus];
  return String(name || "").trim();
}

function parseDiaryDate(token) {
  const m = String(token || "").trim().match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (!m) return null;
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const mon = months[m[2].toLowerCase()];
  if (mon == null) return null;
  return new Date(YEAR, mon, parseInt(m[1], 10), 12, 0, 0, 0);
}

function resolveSubtype(wantName, plants) {
  const want = norm(wantName);
  for (const plant of plants) {
    if (!plant.sowingAllowed) continue;
    for (const st of plant.subtypes || []) {
      if (norm(st.name) === want) return { plant, subtype: st };
    }
  }
  return null;
}

async function main() {
  console.log("=== DRY RUN INSERT — diary sowing (lot = batch, farmer = RAISING) ===");
  console.log(`Year ${YEAR} · ready = sow + ${READY_DAYS}d · no writes\n`);

  await mongoose.connect(process.env.PROD_MONGO_URL);

  const plants = await PlantCms.find({})
    .select("name sowingAllowed subtypes")
    .lean();
  const sowingPlants = plants.filter((p) => p.sowingAllowed);

  const results = [];
  for (let i = 0; i < ROWS.length; i++) {
    const row = ROWS[i];
    const sowDate = parseDiaryDate(row.sow);
    const readyDate = sowDate ? addDays(sowDate, READY_DAYS) : null;
    const readyStr = readyDate ? fmtDDMMYYYY(readyDate) : "—";
    const cmsName = canonical(row.variety);
    const resolved = resolveSubtype(cmsName, sowingPlants);
    const pktTotal = (row.batches || []).reduce((s, b) => s + (Number(b.pkt) || 0), 0);

    const out = {
      idx: i + 1,
      sow: row.sow,
      readyStr,
      variety: row.variety,
      cmsName,
      qty: row.qty,
      raising: row.raising,
      seed: row.raising ? "RAISING" : "COMPANY",
      batches: row.batches,
      pktTotal,
      note: row.note || "",
    };

    if (!resolved) {
      out.ok = false;
      out.blockers = ["NO_SUBTYPE"];
      results.push(out);
      continue;
    }

    const cmsDays = Number(resolved.subtype.plantReadyDays) || 0;
    const product = await Product.findOne({
      plantId: resolved.plant._id,
      subtypeId: resolved.subtype._id,
      category: { $regex: /^seeds$/i },
      isActive: true,
    })
      .select("name code")
      .lean();

    const slot = await findSlotByPlantReadyDate(
      resolved.plant._id,
      resolved.subtype._id,
      readyStr
    );

    out.plant = resolved.plant.name;
    out.subtype = resolved.subtype.name;
    out.cmsDays = cmsDays;
    out.product = product?.name || null;
    out.slotFound = Boolean(slot?.slotId);
    out.slotLabel = slot?.startDay
      ? slot.endDay && slot.startDay !== slot.endDay
        ? `${slot.startDay} → ${slot.endDay}`
        : slot.startDay
      : "—";

    const blockers = [];
    if (!out.slotFound) blockers.push("NO_SLOT");
    if (cmsDays !== READY_DAYS) blockers.push(`CMS_DAYS_${cmsDays}`);
    if (!product && !row.raising) blockers.push("NO_PRODUCT");
    if (!product && row.raising) blockers.push("NO_PRODUCT_RAISING_OK");
    out.blockers = blockers;
    out.ok = !blockers.includes("NO_SLOT") && !blockers.includes("NO_SUBTYPE");
    results.push(out);
  }

  for (const r of results) {
    const flag = r.ok ? "OK" : "BLOCK";
    const batchStr = (r.batches || []).map((b) => `${b.pkt} pkt ${b.batch}`).join(" + ");
    console.log(
      `\n#${r.idx} ${flag} · ${r.sow} → ready ${r.readyStr} · ${r.variety} → ${r.plant || "?"} / ${r.subtype || r.cmsName}`
    );
    console.log(
      `  ${fmt(r.qty)} plants · ${r.seed} · ${r.pktTotal} pkt · ${batchStr}${r.note ? ` · ${r.note}` : ""}`
    );
    if (r.plant) {
      console.log(
        `  CMS ready ${r.cmsDays}d · product ${r.product || "NONE"} · slot ${r.slotFound ? r.slotLabel : "MISSING"}`
      );
    }
    if (r.blockers?.length) console.log(`  ⚠ ${r.blockers.join(" · ")}`);
  }

  const ok = results.filter((r) => r.ok);
  const blocked = results.filter((r) => !r.ok);
  const noSubtype = results.filter((r) => r.blockers?.includes("NO_SUBTYPE"));
  const noSlot = results.filter((r) => r.blockers?.includes("NO_SLOT"));
  const noProduct = results.filter((r) =>
    r.blockers?.some((b) => b.startsWith("NO_PRODUCT"))
  );
  const daysMismatch = results.filter((r) => r.blockers?.some((b) => b.startsWith("CMS_DAYS_")));
  const raising = results.filter((r) => r.raising);

  console.log(`\n${"=".repeat(72)}`);
  console.log("INSERT DRY RUN SUMMARY");
  console.log("=".repeat(72));
  console.log(`Rows: ${results.length}`);
  console.log(`Can insert (subtype + slot): ${ok.length}`);
  console.log(`Blocked: ${blocked.length}`);
  console.log(`No subtype: ${noSubtype.length}${noSubtype.length ? " → " + noSubtype.map((r) => `#${r.idx} ${r.variety}`).join(", ") : ""}`);
  console.log(`No ready-date slot: ${noSlot.length}${noSlot.length ? " → " + noSlot.map((r) => `#${r.idx} ${r.variety} ${r.readyStr}`).join(", ") : ""}`);
  console.log(`No seed product: ${[...new Set(noProduct.map((r) => r.cmsName))].join(", ") || "none"}`);
  console.log(`CMS ready days ≠ 18: ${daysMismatch.length}${daysMismatch.length ? " → " + [...new Set(daysMismatch.map((r) => `${r.cmsName}=${r.cmsDays}`))].join(", ") : ""}`);
  console.log(`Raising rows: ${raising.length} · plants ${fmt(raising.reduce((s, r) => s + r.qty, 0))}`);
  console.log(`Company rows: ${results.length - raising.length} · plants ${fmt(results.filter((r) => !r.raising).reduce((s, r) => s + r.qty, 0))}`);
  console.log(`Total plants: ${fmt(results.reduce((s, r) => s + r.qty, 0))}`);
  console.log(`Total packets: ${results.reduce((s, r) => s + r.pktTotal, 0)}`);

  console.log("\nInsert would be admin-direct-sow: plants → ready slot, batch numbers recorded, raising skips warehouse.");
  console.log("Packet stock in inventory is NOT deducted in this path (admin bypass).");

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
