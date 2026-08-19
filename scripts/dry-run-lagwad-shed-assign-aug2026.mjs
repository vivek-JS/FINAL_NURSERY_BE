/**
 * Dry-run: Aug 2026 lagwad lines with correct shed assignment + slot rollup.
 *
 *   node scripts/dry-run-lagwad-shed-assign-aug2026.mjs
 */
import moment from "moment";
import { splitLagwadQtyForSlot, LAGWAD_ACTUAL_PLANTS_PCT } from "../utility/lagwadSlotPlantsSplit.js";

const SHED_23_NAME = "23 no (विशाल गड)";
const SHED_23_NUMBER = "23";
const SHED_23_POLLYHOUSE = `${SHED_23_NAME} (${SHED_23_NUMBER})`;

const SHED_TORNA_NAME = "Torna (तोरणा)";
const SHED_TORNA_NUMBER = "5";
const SHED_TORNA_POLLYHOUSE = `${SHED_TORNA_NAME} (${SHED_TORNA_NUMBER})`;

/** Diary lagwad lines — shed fix: first 3 → 23 no Vishal gad, last → Torna. */
const ENTRIES = [
  {
    lagwadDate: "2026-08-02",
    batch: "SB-307",
    plants: 42992,
    readyDate: "2026-09-01",
    bookingSlot: "27 Aug – 2 Sep",
    pollyhouse: SHED_23_POLLYHOUSE,
    shedLabel: SHED_23_NAME,
  },
  {
    lagwadDate: "2026-08-07",
    batch: "SB-68",
    plants: 41280,
    readyDate: "2026-09-06",
    bookingSlot: "3 – 9 Sep",
    pollyhouse: SHED_23_POLLYHOUSE,
    shedLabel: SHED_23_NAME,
  },
  {
    lagwadDate: "2026-08-10",
    batch: "SB-98",
    plants: 41168,
    readyDate: "2026-09-09",
    bookingSlot: "3 – 9 Sep (same)",
    pollyhouse: SHED_23_POLLYHOUSE,
    shedLabel: SHED_23_NAME,
  },
  {
    lagwadDate: "2026-08-17",
    batch: "SB-128",
    plants: 41048,
    readyDate: "2026-09-16",
    bookingSlot: "10 – 16 Sep",
    pollyhouse: SHED_TORNA_POLLYHOUSE,
    shedLabel: SHED_TORNA_NAME,
  },
];

const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

function slotKey(label) {
  return label.replace(/\s*\(same\)\s*/i, "").trim();
}

console.log("=== DRY RUN — Lagwad shed assignment (Aug 2026) ===\n");
console.log(`Split: ${LAGWAD_ACTUAL_PLANTS_PCT}% actualPlants · 10% expectedMortality`);
console.log(`Shed rename: #23 → "${SHED_23_NAME}"`);
console.log(`Dispatch rule: subtract actualReady only\n`);

console.log(
  "Lagwad".padEnd(10) +
    "Batch".padEnd(8) +
    "Physical".padStart(12) +
    "On slot 90%".padStart(12) +
    "Mort 10%".padStart(10) +
    "  Ready".padEnd(12) +
    "Booking slot".padEnd(18) +
    "Shed"
);
console.log("-".repeat(100));

let sumGross = 0;
let sumActual = 0;
let sumMort = 0;
const slotRollup = new Map();

for (const row of ENTRIES) {
  const split = splitLagwadQtyForSlot(row.plants);
  sumGross += row.plants;
  sumActual += split.actualPlants;
  sumMort += split.expectedMortality;

  const sk = slotKey(row.bookingSlot);
  const slot = slotRollup.get(sk) || {
    actual: 0,
    mortality: 0,
    ready: 0,
    gross: 0,
    lines: [],
  };
  slot.actual += split.actualPlants;
  slot.mortality += split.expectedMortality;
  slot.ready += split.actualPlants;
  slot.gross += row.plants;
  slot.lines.push(row);
  slotRollup.set(sk, slot);

  console.log(
    moment(row.lagwadDate).format("D/M/YY").padEnd(10) +
      row.batch.padEnd(8) +
      fmt(row.plants).padStart(12) +
      fmt(split.actualPlants).padStart(12) +
      fmt(split.expectedMortality).padStart(10) +
      "  " +
      moment(row.readyDate).format("D/M/YY").padEnd(10) +
      row.bookingSlot.padEnd(18) +
      row.shedLabel
  );
}

console.log("-".repeat(100));
console.log(
  "Total".padEnd(10) +
    "".padEnd(8) +
    fmt(sumGross).padStart(12) +
    fmt(sumActual).padStart(12) +
    fmt(sumMort).padStart(10)
);
console.log(
  `\nLagwad total (actual + mort.): ${fmt(sumActual + sumMort)} (expected 166,488)`
);
console.log(`Expected actual: ${fmt(sumActual)} (expected 149,838)`);
console.log(`Expected mortality: ${fmt(sumMort)} (expected 16,650)`);

console.log("\n--- Per booking slot rollup ---");
for (const [label, s] of slotRollup) {
  console.log(
    `${label}: gross ${fmt(s.gross)} · actual ${fmt(s.actual)} · mort ${fmt(s.mortality)} · ready ${fmt(s.ready)}`
  );
  for (const ln of s.lines) {
    console.log(
      `  batch ${ln.batch} → pollyhouse "${ln.pollyhouse}"`
    );
  }
}

console.log("\n--- Shed stock rollup (physical by shed) ---");
const shed23 = ENTRIES.filter((e) => e.pollyhouse === SHED_23_POLLYHOUSE);
const shedTorna = ENTRIES.filter((e) => e.pollyhouse === SHED_TORNA_POLLYHOUSE);
const rollupShed = (list) => {
  let g = 0;
  let a = 0;
  let m = 0;
  for (const r of list) {
    const s = splitLagwadQtyForSlot(r.plants);
    g += r.plants;
    a += s.actualPlants;
    m += s.expectedMortality;
  }
  return { g, a, m };
};
const r23 = rollupShed(shed23);
const rT = rollupShed(shedTorna);
console.log(
  `${SHED_23_NAME}: physical ${fmt(r23.g)} · on slot ${fmt(r23.a)} · mortality ${fmt(r23.m)}`
);
console.log(
  `${SHED_TORNA_NAME}: physical ${fmt(rT.g)} · on slot ${fmt(rT.a)} · mortality ${fmt(rT.m)}`
);

console.log("\n--- Prod fix plan (if lines imported with wrong shed) ---");
console.log("Batches 307, 68, 98: pollyhouse →", SHED_23_POLLYHOUSE);
console.log("Batch 128: pollyhouse →", SHED_TORNA_POLLYHOUSE);
console.log("Shade #23 name →", SHED_23_NAME);
console.log("\nRun: node scripts/fix-lagwad-shed-prod.mjs");
console.log("Then: node scripts/fix-lagwad-shed-prod.mjs --apply");
