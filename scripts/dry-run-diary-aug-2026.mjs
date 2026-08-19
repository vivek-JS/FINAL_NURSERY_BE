/**
 * Dry-run: diary lagwad / revised stock entries (photos 18 Aug 2026).
 * SB diary batches → SB-OLD. Excludes removed 23 no · SB · 164,360 line.
 *
 *   node scripts/dry-run-diary-aug-2026.mjs
 */
import {
  splitLagwadQtyForSlot,
  LAGWAD_ACTUAL_PLANTS_PCT,
} from "../utility/lagwadSlotPlantsSplit.js";

const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

/** Diary batch label: plain "SB" → SB-OLD */
const diaryBatch = (batch) => {
  const b = String(batch ?? "").trim();
  if (b === "SB") return "SB-OLD";
  return b;
};

/** Photo 1 — Sinhagad / Raigad lagwad lines (total 111,672). */
const LAGWAD_LINES = [
  { location: "Sinhagad", batch: "vasai-278", plants: 7864 },
  { location: "Sinhagad", batch: "912", plants: 12224 },
  { location: "Raigad", batch: "vasai-911", plants: 91584 },
];

/**
 * Photo 2 — Revised stock on 18/8/26.
 * Removed: 23 no · SB · 164,360 (per prod correction).
 */
const REVISED_STOCK_18_8_26 = [
  { location: "Pratapgad", batch: "19", plants: 25760 },
  { location: "Pratapgad", batch: "SB", plants: 5132 },
  { location: "Torna", batch: "SB", plants: 9740 },
  { location: "Purandar", batch: "510", plants: 19280 },
  { location: "Purandar", batch: "38", plants: 2496 },
  { location: "Purandar", batch: "19", plants: 36372 },
  { location: "Purandar", batch: "SB", plants: 7872 },
  { location: "Rajgad", batch: "19", plants: 16068 },
  { location: "Rajgad", batch: "38", plants: 1088 },
  { location: "Rajgad", batch: "510", plants: 39180 },
  { location: "Rajgad", batch: "SB", plants: 16751 },
  { location: "Devgiri", batch: "19", plants: 15280 },
  { location: "Devgiri", batch: "38", plants: 11570 },
  { location: "Devgiri", batch: "510", plants: 45700 },
  { location: "Devgiri", batch: "SB", plants: 24382 },
  { location: "Shivneri", batch: "19", plants: 10612 },
  { location: "12 no (Vishal gad)", batch: "mix", plants: 6000 },
  { location: "23 no", batch: "CB", plants: 22456 },
  { location: "Purandar", batch: "mix", plants: 29960, note: "june rope" },
];

function printTable(title, entries, useDiaryBatch = false) {
  console.log(`\n=== ${title} ===\n`);
  console.log(
    "Location".padEnd(22) +
      "Batch".padEnd(14) +
      "Gross".padStart(12) +
      "Actual 90%".padStart(12) +
      "Mort 10%".padStart(10)
  );
  console.log("-".repeat(66));

  let sumGross = 0;
  let sumActual = 0;
  let sumMort = 0;

  for (const row of entries) {
    const s = splitLagwadQtyForSlot(row.plants);
    sumGross += row.plants;
    sumActual += s.actualPlants;
    sumMort += s.expectedMortality;
    const batchLabel = useDiaryBatch ? diaryBatch(row.batch) : row.batch;
    const locLabel =
      row.note ? `${row.location} (${row.note})` : row.location;
    console.log(
      String(locLabel).padEnd(22) +
        String(batchLabel).padEnd(14) +
        fmt(row.plants).padStart(12) +
        fmt(s.actualPlants).padStart(12) +
        fmt(s.expectedMortality).padStart(10)
    );
  }

  console.log("-".repeat(66));
  console.log(
    "TOTAL".padEnd(22) +
      "".padEnd(14) +
      fmt(sumGross).padStart(12) +
      fmt(sumActual).padStart(12) +
      fmt(sumMort).padStart(10)
  );
  console.log(
    `\nLagwad total (actual + mort.): ${fmt(sumActual + sumMort)}  |  sellable actual 90%: ${fmt(sumActual)}`
  );
  return { gross: sumGross, actual: sumActual, mortality: sumMort };
}

console.log("DRY RUN — diary entries · 90/10 lagwad split");
console.log(`Rule: ${LAGWAD_ACTUAL_PLANTS_PCT}% → actualPlants, 10% → expectedMortality`);
console.log("Rule: SB diary batches shown as SB-OLD");
console.log("Excluded: 23 no · SB · 1,64,360\n");

const a = printTable("Photo 1 — Sinhagad / Raigad lagwad", LAGWAD_LINES, false);
const b = printTable("Photo 2 — Revised stock 18/8/26", REVISED_STOCK_18_8_26, true);

console.log("\n=== Combined (both photos) ===");
console.log(`Gross plants:     ${fmt(a.gross + b.gross)}`);
console.log(`Actual 90%:       ${fmt(a.actual + b.actual)}`);
console.log(`Exp. mortality:   ${fmt(a.mortality + b.mortality)}`);
console.log(`Lagwad total:     ${fmt(a.actual + b.actual + a.mortality + b.mortality)}`);
