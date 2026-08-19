/**
 * Dry-run: delete completed sowing entries, then diary insert → slot impact.
 *   node scripts/sowing-diary-slot-impact-table.mjs
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import Product from "../models/product.model.js";
import Sowing from "../models/sowing.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import {
  addDays,
  fmtDDMMYYYY,
  findSlotByPlantReadyDate,
} from "../controllers/sowingSlotReadyHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const READY_DAYS = 18;
const YEAR = 2026;
const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

const ALIASES = {
  impact: "Impact",
  melody: "Melody",
  simbha: "SImbha",
  bhujang: "Bhujang Plus",
  "bhujang+": "Bhujang Plus",
  "bhujang plus": "Bhujang Plus",
  kargil: "Karlgil Plus",
  redking: "Redking",
  "red king": "Redking",
  singham: "Singham",
  vijay: "Vijay",
  shivaji: "Shivaji",
};

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
  { sow: "2-Aug", variety: "Simbha", qty: 42960, raising: false, batches: [{ batch: "21050026", pkt: 43 }] },
  { sow: "3-Aug", variety: "Red King", qty: 29736, raising: false, batches: [{ batch: "GRB-JLN-261", pkt: 28 }] },
  { sow: "3-Aug", variety: "Impact", qty: 15750, raising: false, batches: [{ batch: "37438001004", pkt: 16 }] },
  { sow: "4-Aug", variety: "Singham", qty: 46620, raising: false, batches: [{ batch: "R50-270-522/1/2", pkt: 41 }] },
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

function norm(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9+ ]/g, "");
}
function canonical(name) {
  const n = norm(name);
  return ALIASES[n] || ALIASES[n.replace(/\+/g, "").trim()] || String(name).trim();
}
function parseDiaryDate(token) {
  const m = String(token).trim().match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (!m) return null;
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  return new Date(YEAR, months[m[2].toLowerCase()], parseInt(m[1], 10), 12, 0, 0, 0);
}

async function main() {
  await mongoose.connect(process.env.PROD_MONGO_URL);

  const completedReq = await SowingRequest.countDocuments({ sowingCompleted: true });
  const allReq = await SowingRequest.countDocuments({});
  const legacy = await Sowing.countDocuments({});

  console.log("=== 1) REMOVE completed sowing entries (DRY RUN) ===");
  console.log(`SowingRequest completed: ${completedReq} (would delete)`);
  console.log(`SowingRequest all: ${allReq}`);
  console.log(`Legacy Sowing docs: ${legacy} (would delete all)`);
  console.log("Raising intakes: KEEP\n");

  const plants = await PlantCms.find({ sowingAllowed: true }).select("name subtypes").lean();
  const productCache = new Map();
  const slotCache = new Map();

  console.log("=== 2) DIARY INSERT → IMPACTED SLOT ===\n");
  console.log(
    "#".padStart(3) +
      "  " +
      "Sow".padEnd(8) +
      "Ready".padEnd(12) +
      "Variety".padEnd(12) +
      "CMS".padEnd(16) +
      "Plants".padStart(10) +
      "  Seed     Slot                  Prod  Packets / batches"
  );
  console.log("-".repeat(140));

  const slotRoll = new Map();
  let ok = 0;
  let blocked = 0;

  for (let i = 0; i < ROWS.length; i++) {
    const row = ROWS[i];
    const sowDate = parseDiaryDate(row.sow);
    const readyStr = fmtDDMMYYYY(addDays(sowDate, READY_DAYS));
    const cmsName = canonical(row.variety);
    let plant = null;
    let st = null;
    for (const p of plants) {
      const hit = (p.subtypes || []).find((s) => norm(s.name) === norm(cmsName));
      if (hit) {
        plant = p;
        st = hit;
        break;
      }
    }
    const pk = plant && st ? `${plant._id}-${st._id}` : "";
    if (pk && !productCache.has(pk)) {
      productCache.set(
        pk,
        await Product.findOne({
          plantId: plant._id,
          subtypeId: st._id,
          category: { $regex: /^seeds$/i },
          isActive: true,
        })
          .select("code name")
          .lean()
      );
    }
    const sk = `${pk}-${readyStr}`;
    if (pk && !slotCache.has(sk)) {
      slotCache.set(sk, await findSlotByPlantReadyDate(plant._id, st._id, readyStr));
    }
    const slot = slotCache.get(sk);
    const prod = productCache.get(pk);
    const slotLabel = slot?.startDay
      ? slot.endDay && slot.startDay !== slot.endDay
        ? `${slot.startDay}→${slot.endDay}`
        : slot.startDay
      : "NO SLOT";
    const cmsLabel = st ? st.name : "NO SUBTYPE";
    const prodLabel = prod ? (prod.code || "Y") : "NO";
    const batchStr = (row.batches || []).map((b) => `${b.pkt}pkt ${b.batch}`).join(" + ");
    if (plant && st && slot) ok++;
    else blocked++;

    if (slot) {
      const rk = `${cmsLabel}|${slotLabel}`;
      if (!slotRoll.has(rk)) slotRoll.set(rk, { cms: cmsLabel, slot: slotLabel, plants: 0, rows: 0, raising: 0 });
      const g = slotRoll.get(rk);
      g.plants += row.qty;
      g.rows += 1;
      if (row.raising) g.raising += row.qty;
    }

    console.log(
      String(i + 1).padStart(3) +
        "  " +
        row.sow.padEnd(8) +
        readyStr.padEnd(12) +
        row.variety.padEnd(12) +
        cmsLabel.padEnd(16) +
        fmt(row.qty).padStart(10) +
        "  " +
        (row.raising ? "RAISING " : "COMPANY ") +
        slotLabel.padEnd(21) +
        String(prodLabel).padEnd(14) +
        batchStr
    );
  }

  console.log("\n=== SLOT ROLLUP (plants that would land) ===\n");
  console.log("Subtype".padEnd(16) + "Slot".padEnd(24) + "Rows".padStart(5) + "Plants".padStart(12) + "Raising".padStart(12));
  console.log("-".repeat(70));
  for (const g of [...slotRoll.values()].sort((a, b) => a.cms.localeCompare(b.cms) || a.slot.localeCompare(b.slot))) {
    console.log(
      g.cms.padEnd(16) + g.slot.padEnd(24) + String(g.rows).padStart(5) + fmt(g.plants).padStart(12) + fmt(g.raising).padStart(12)
    );
  }

  console.log(`\nInsert OK: ${ok}/${ROWS.length} · blocked: ${blocked}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
