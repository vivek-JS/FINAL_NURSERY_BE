/**
 * Dry-run spreadsheet sow rows → prod orders + ready-date slots + admin-direct-sow payload.
 *
 *   node scripts/dry-run-add-sheet-sows.mjs --prod
 *   node scripts/dry-run-add-sheet-sows.mjs --prod --only Impact
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import Order from "../models/order.model.js";
import {
  parseLocalDate,
  fmtDDMMYYYY,
  findSlotByPlantReadyDate,
} from "../controllers/sowingSlotReadyHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const args = process.argv.slice(2);
const prod = args.includes("--prod");
const onlyIdx = args.indexOf("--only");
const onlyFilter =
  onlyIdx >= 0 && args[onlyIdx + 1] ? args[onlyIdx + 1] : null;

const uri = prod
  ? process.env.PROD_MONGO_URL
  : process.env.STAGE_MONGO_URL || process.env.MONGO_URL;

function parseSheetDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) return parseLocalDate(s);
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let y = parseInt(slash[3], 10);
    if (y < 100) y += 2000;
    const a = parseInt(slash[1], 10);
    const b = parseInt(slash[2], 10);
    let month;
    let day;
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      month = a;
      day = b;
    } else {
      month = a;
      day = b;
    }
    const iso = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return parseLocalDate(iso);
  }
  return parseLocalDate(s);
}

function parseSowDay(raw) {
  const m = String(raw).match(/^(\d+)-([A-Za-z]+)-(\d+)$/);
  if (!m) return parseSheetDate(raw);
  const months = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const mon = months[m[2].slice(0, 3)] || "07";
  return parseLocalDate(`${m[3]}-${mon}-${String(m[1]).padStart(2, "0")}`);
}

function parsePkt(raw) {
  const m = String(raw || "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

function fmt(n) {
  return Number(n || 0).toLocaleString("en-IN");
}

function ymdFromDate(d) {
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const SHEET_ROWS = [
  { sowDay: "27-Jul-2026", variety: "Simbha", plants: 18270, batch: "21046327", ready: "9/26/26", packets: "18 pkt" },
  { sowDay: "27-Jul-2026", variety: "melody", plants: 10017, batch: "2601461", ready: "28-03-2027", packets: "8 pkt", note: "Farmer seed" },
  { sowDay: "27-Jul-2026", variety: "melody", plants: 22176, batch: "2602506", ready: "21/03/27", packets: "18 pkt", note: "Farmer seed" },
  { sowDay: "27-Jul-2026", variety: "melody", plants: 12348, batch: "2602559", ready: "21/03/27", packets: "09 pkt" },
  { sowDay: "27-Jul-2026", variety: "Singham", plants: 20160, batch: "R50270-522/1/2", ready: "3/25/27", packets: "17pkt" },
  { sowDay: "28-Jul-2026", variety: "Impact", plants: 15750, batch: "35438001004", ready: "3/10/27", packets: "16 pkt" },
  { sowDay: "28-Jul-2026", variety: "Bhujang +", plants: 10458, batch: "SNX-2006", ready: "3/13/27", packets: "8 pkt", note: "Farmer seed" },
  { sowDay: "28-Jul-2026", variety: "Shivaji", plants: 105336, batch: "25227", ready: "4/8/27", packets: "80 pkt", note: "Farmer seed" },
  { sowDay: "28-Jul-2026", variety: "Red King", plants: 47124, batch: "GRB-JLN-261", ready: "1/31/27", packets: "45 Pkt" },
];

/** Spreadsheet label → CMS subtype name */
const VARIETY_ALIASES = {
  "bhujang +": "bahubali plus",
  bhujang: "bahubali plus",
  "bhujang+": "bahubali plus",
  bhjang: "bahubali plus",
  "bhjang +": "bahubali plus",
  "bhujang plus": "bahubali plus",
  "red king": "redking",
};

async function resolveSubtype(variety, plantMap) {
  const raw = String(variety || "").trim().toLowerCase();
  const aliased = VARIETY_ALIASES[raw] || raw.replace(/\s+/g, " ").trim();
  const v = aliased.replace(/\s+/g, "").trim();
  const vSpaced = aliased;

  for (const [, p] of plantMap) {
    for (const st of p.subtypes || []) {
      const name = String(st.name || "").toLowerCase();
      const nameNorm = name.replace(/[^a-z0-9]+/g, "");
      if (
        name === vSpaced ||
        nameNorm === v ||
        name.includes(vSpaced) ||
        vSpaced.includes(name)
      ) {
        return { plant: p, subtype: st };
      }
    }
  }
  return null;
}

async function findOrdersForReadyDate(plantId, subtypeId, readyDate) {
  const dayStart = new Date(readyDate);
  dayStart.setHours(0, 0, 0, 0);
  dayStart.setDate(dayStart.getDate() - 4);
  const dayEnd = new Date(readyDate);
  dayEnd.setHours(23, 59, 59, 999);
  dayEnd.setDate(dayEnd.getDate() + 4);

  const orders = await Order.find({
    plantName: plantId,
    plantSubtype: subtypeId,
    sowingDone: { $ne: true },
    orderStatus: { $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"] },
    deliveryDate: { $gte: dayStart, $lte: dayEnd },
  })
    .select("orderId name numberOfPlants additionalPlants deliveryDate bookingSlot")
    .sort({ deliveryDate: 1, orderId: 1 })
    .lean();

  const totalNeed = orders.reduce(
    (s, o) => s + (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
    0
  );
  return { orders, totalNeed };
}

async function dryRunRow(row, plantMap) {
  const sowDate = parseSowDay(row.sowDay);
  const readyDate = parseSheetDate(row.ready);
  const readyStr = readyDate ? fmtDDMMYYYY(readyDate) : "?";
  const sowStr = sowDate ? fmtDDMMYYYY(sowDate) : "?";
  const sowYmd = sowDate ? ymdFromDate(sowDate) : "";
  const readyYmd = readyDate ? ymdFromDate(readyDate) : "";
  const plantReadyDays =
    sowDate && readyDate ? Math.round((readyDate - sowDate) / 86400000) : null;

  const match = await resolveSubtype(row.variety, plantMap);
  const out = {
    variety: row.variety,
    plants: row.plants,
    batch: row.batch,
    packets: parsePkt(row.packets),
    sowDate: sowStr,
    readyDate: readyStr,
    plantReadyDays,
    cms: null,
    slot: null,
    orders: [],
    orderPlants: 0,
    excess: row.plants,
    apiPayload: null,
    issues: [],
  };

  if (!match) {
    out.issues.push(`Subtype not found: ${row.variety}`);
    return out;
  }

  const { plant, subtype } = match;
  out.cms = {
    plantId: String(plant._id),
    plantName: plant.name,
    subtypeId: String(subtype._id),
    subtypeName: subtype.name,
  };

  if (!readyDate) {
    out.issues.push(`Bad ready date: ${row.ready}`);
    return out;
  }

  const slot = await findSlotByPlantReadyDate(plant._id, subtype._id, readyStr);
  if (slot?.slotId) {
    out.slot = {
      slotId: String(slot.slotId),
      startDay: slot.startDay,
      endDay: slot.endDay,
    };
  } else {
    out.issues.push(`No slot for ready ${readyStr}`);
  }

  const { orders, totalNeed } = await findOrdersForReadyDate(
    plant._id,
    subtype._id,
    readyDate
  );
  out.orders = orders.map((o) => ({
    orderId: o.orderId,
    _id: String(o._id),
    plants: (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
    deliveryDate: o.deliveryDate,
    bookingSlot: o.bookingSlot ? String(o.bookingSlot) : null,
  }));
  out.orderPlants = totalNeed;
  out.excess = Math.max(0, row.plants - totalNeed);

  const orderIds = orders.map((o) => String(o._id));
  out.apiPayload = {
    sowDate: sowYmd,
    date: sowYmd,
    readyDate: readyYmd,
    plantReadyDays: plantReadyDays ?? undefined,
    plantsSowed: row.plants,
    packetsUsed: parsePkt(row.packets),
    batchNumber: row.batch,
    shedName: "Office",
    plantId: String(plant._id),
    subtypeId: String(subtype._id),
    notes: `Sheet sow ${row.variety} · ${sowStr} · batch ${row.batch}`,
    ...(orderIds.length ? { orderIds } : slot?.slotId ? { slotId: String(slot.slotId) } : {}),
  };

  if (!orderIds.length) out.issues.push("No unsowed orders ±4d — excess-only");
  if (row.plants < totalNeed) {
    out.issues.push(`Plants ${row.plants} < window need ${totalNeed}`);
  }

  return out;
}

async function main() {
  console.log("\n=== DRY RUN add sheet sow entries ===");
  console.log(`DB: ${prod ? "PRODUCTION" : "stage/dev"}`);
  if (onlyFilter) console.log(`Filter: ${onlyFilter}`);

  await mongoose.connect(uri);

  const plants = await PlantCms.find({ sowingAllowed: true })
    .select("_id name subtypes._id subtypes.name")
    .lean();
  const plantMap = new Map(plants.map((p) => [String(p._id), p]));

  let rows = SHEET_ROWS;
  if (onlyFilter) {
    rows = rows.filter((r) =>
      r.variety.toLowerCase().includes(onlyFilter.toLowerCase())
    );
  }

  for (const row of rows) {
    const r = await dryRunRow(row, plantMap);
    console.log("\n" + "─".repeat(60));
    console.log(`${r.variety} | sow ${r.sowDate} → ready ${r.readyDate} (${r.plantReadyDays}d)`);
    console.log(`Plants: ${fmt(r.plants)} | Pkts: ${r.packets} | Batch: ${row.batch}`);
    if (r.cms) console.log(`CMS: ${r.cms.plantName} · ${r.cms.subtypeName}`);
    if (r.slot) {
      console.log(`Slot: ${r.slot.startDay} – ${r.slot.endDay} (${r.slot.slotId})`);
    }
    console.log(`Orders ±4d: ${r.orders.length} (${fmt(r.orderPlants)} plants)`);
    for (const o of r.orders.slice(0, 10)) {
      const del = o.deliveryDate instanceof Date ? o.deliveryDate.toISOString().slice(0, 10) : o.deliveryDate;
      console.log(`  #${o.orderId} · ${fmt(o.plants)} · del ${del} · bookSlot ${o.bookingSlot || "—"}`);
    }
    console.log(`Excess: ${fmt(r.excess)}`);
    if (r.issues.length) console.log("Issues:", r.issues.join("; "));
    console.log("Payload:", JSON.stringify(r.apiPayload, null, 2));
  }

  console.log("\n✓ DRY RUN complete.\n");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
