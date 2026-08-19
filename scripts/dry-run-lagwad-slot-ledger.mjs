/**
 * Dry-run: lagwad → slot ledger with 90% actual / 10% expected mortality.
 *
 *   node scripts/dry-run-lagwad-slot-ledger.mjs
 */
import moment from "moment";
import {
  splitLagwadQtyForSlot,
  LAGWAD_ACTUAL_PLANTS_PCT,
} from "../utility/lagwadSlotPlantsSplit.js";

const SAMPLE = [
  { date: "2026-08-01", plants: 0, batch: null },
  { date: "2026-08-02", plants: 42992, batch: "SB-307" },
  { date: "2026-08-03", plants: 0, batch: null },
  { date: "2026-08-04", plants: 0, batch: null },
  { date: "2026-08-05", plants: 0, batch: null },
  { date: "2026-08-06", plants: 0, batch: null },
  { date: "2026-08-07", plants: 41280, batch: "SB-68" },
  { date: "2026-08-08", plants: 0, batch: null },
  { date: "2026-08-09", plants: 0, batch: null },
  { date: "2026-08-10", plants: 41168, batch: "SB-98" },
  { date: "2026-08-11", plants: 0, batch: null },
  { date: "2026-08-12", plants: 0, batch: null },
  { date: "2026-08-13", plants: 0, batch: null },
  { date: "2026-08-14", plants: 0, batch: null },
  { date: "2026-08-15", plants: 0, batch: null },
  { date: "2026-08-16", plants: 0, batch: null },
  { date: "2026-08-17", plants: 41048, batch: "SB-128" },
  { date: "2026-08-18", plants: 0, batch: null },
];

const READY_DAYS = 14;

function fmt(n) {
  return Number(n || 0).toLocaleString("en-IN");
}

function lagwadEntry(slot, qty, batch, date) {
  const split = splitLagwadQtyForSlot(qty);
  slot.actualPlants += split.actualPlants;
  slot.expectedMortality += split.expectedMortality;
  slot.entries.push({
    qty,
    batch,
    lagwadDate: date,
    split,
    readyOn: null,
  });
}

function applyReadyUpTo(slot, asOf) {
  const m = moment(asOf).startOf("day");
  for (const e of slot.entries) {
    if (e.readyOn || e.split.actualPlants < 1) continue;
    const ready = moment(e.lagwadDate).add(READY_DAYS, "days").startOf("day");
    if (m.isSameOrAfter(ready)) {
      e.readyOn = ready.format("YYYY-MM-DD");
      slot.actualReadyPlants += e.split.actualPlants;
      slot.lagwadRemaining += e.split.actualPlants;
    }
  }
}

function dispatch(slot, qty, label) {
  const q = Math.min(qty, slot.lagwadRemaining);
  slot.lagwadRemaining -= q;
  slot.dispatched += q;
  slot.log.push({ type: "dispatch", qty: q, label });
  return q;
}

function transferMortalityToReady(slot, qty) {
  const t = Math.min(qty, slot.expectedMortality);
  slot.expectedMortality -= t;
  slot.actualReadyPlants += t;
  slot.lagwadRemaining += t;
  return t;
}

function printSlot(slot, label) {
  console.log(`  ${label}`);
  console.log(`    actualPlants (${LAGWAD_ACTUAL_PLANTS_PCT}%)  ${fmt(slot.actualPlants)}`);
  console.log(`    expectedMortality (10%)     ${fmt(slot.expectedMortality)}`);
  console.log(`    actualReady                 ${fmt(slot.actualReadyPlants)}`);
  console.log(`    lagwadRemaining (dispatch)  ${fmt(slot.lagwadRemaining)}`);
  console.log(`    dispatched                  ${fmt(slot.dispatched)}`);
}

const slot = {
  actualPlants: 0,
  expectedMortality: 0,
  actualReadyPlants: 0,
  lagwadRemaining: 0,
  dispatched: 0,
  entries: [],
  log: [],
};

console.log("=== DRY RUN: Lagwad 90/10 → slot ledger ===\n");
console.log(`Rule: lagwad → ${LAGWAD_ACTUAL_PLANTS_PCT}% actualPlants + 10% expectedMortality`);
console.log("Rule: when ready → +actualReady +lagwadRemaining (90% portion only)");
console.log("Rule: dispatch → −lagwadRemaining only\n");

let totalLagwad = 0;
for (const row of SAMPLE) {
  if (row.plants > 0) {
    totalLagwad += row.plants;
    lagwadEntry(slot, row.plants, row.batch, row.date);
    const s = splitLagwadQtyForSlot(row.plants);
    console.log(
      `${moment(row.date).format("D/M/YY")}  lagwad ${fmt(row.plants)}  → actual ${fmt(s.actualPlants)} + mortality ${fmt(s.expectedMortality)}  SB ${row.batch}`
    );
  }
}

console.log(`\nTotal lagwad: ${fmt(totalLagwad)} (expected 166,488)`);
console.log(
  `Split total: actual ${fmt(slot.actualPlants)} + mortality ${fmt(slot.expectedMortality)} = ${fmt(slot.actualPlants + slot.expectedMortality)}\n`
);

applyReadyUpTo(slot, "2026-08-18");
printSlot(slot, "After lagwad + ready by 18/8/26:");

const d1 = dispatch(slot, 50000, "Vehicle load #1");
console.log(`\nDispatch ${fmt(50000)} (capped ${fmt(d1)}):`);
printSlot(slot, "After dispatch 1:");

applyReadyUpTo(slot, "2026-09-01");
const d2 = dispatch(slot, 120000, "Vehicle load #2");
console.log(`\nDispatch ${fmt(120000)} after more ready (capped ${fmt(d2)}):`);
printSlot(slot, "After dispatch 2:");

const transferred = transferMortalityToReady(slot, 5000);
console.log(`\nTransfer ${fmt(5000)} exp. mortality → ready (moved ${fmt(transferred)}):`);
printSlot(slot, "After mortality transfer:");
