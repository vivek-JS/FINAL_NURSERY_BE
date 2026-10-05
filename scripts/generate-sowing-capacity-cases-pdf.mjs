/**
 * Worked examples for the sowing capacity sheet.
 *   node scripts/generate-sowing-capacity-cases-pdf.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import moment from "moment";
import {
  canBookPlants,
  capacityStatus,
  capacityStatusLabel,
  majoritySeedPlan,
  slotOverlapsRange,
} from "../utility/capacitySheetMetrics.js";
import { IST_OFFSET } from "../utility/istSlotDate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, "../../docs/SOWING_CAPACITY_CASES.pdf");

function line(doc, text, opts = {}) {
  doc.font(opts.font || "Helvetica").fontSize(opts.size || 10).fillColor(opts.color || "#111").text(text, {
    width: 515,
    lineGap: 2,
  });
  doc.moveDown(opts.gap == null ? 0.25 : opts.gap);
}

function h(doc, text) {
  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f766e").text(text, { width: 515 });
  doc.moveDown(0.2);
  doc.strokeColor("#0f766e").moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.35);
}

function example(doc, title, body) {
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#134e4a").text(title, { width: 515 });
  doc.moveDown(0.15);
  for (const row of body) line(doc, row, { size: 10 });
  doc.moveDown(0.35);
}

function ensure(doc, need = 90) {
  if (doc.y > 760 - need) doc.addPage();
}

const from = moment("2026-10-15", "YYYY-MM-DD").utcOffset(IST_OFFSET, true).startOf("day");
const to = moment("2026-10-31", "YYYY-MM-DD").utcOffset(IST_OFFSET, true).endOf("day");

const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: "Sowing capacity — complete cases" } });
fs.mkdirSync(path.dirname(outPath), { recursive: true });
doc.pipe(fs.createWriteStream(outPath));

line(doc, "Ram Biotech  ·  Sowing capacity sheet", { font: "Helvetica-Bold", size: 16, color: "#0f766e", gap: 0.1 });
line(doc, "Complete worked examples. Numbers use the same functions as the live API.", { size: 10, color: "#334155", gap: 0.4 });
line(doc, "Screen: /u/sowing-capacity");
line(doc, "API: GET /api/v1/sowing/capacity-sheet?from=YYYY-MM-DD&to=YYYY-MM-DD");
line(doc, "Drawer: GET /api/v1/sowing/capacity-sheet/slot/:slotId");

h(doc, "How one row is calculated");
line(doc, "Booked = plants on pipeline orders whose delivery date falls in the slot. Pipeline statuses: ACCEPTED, PENDING, READY_FOR_DISPATCH, DISPATCH_PROCESS. Cancelled, rejected, temporary cancelled, dispatched, completed, and dealer-quota orders are left out.");
line(doc, "Sowed = those same booked plants where sowingDone is true.");
line(doc, "Gap = booked plants where sowingDone is still false.");
line(doc, "Excess = plants already sowed on the slot, minus plants reserved for covered orders. If nothing was sowed, excess is 0. Empty slot capacity is not excess.");
line(doc, "Can book = max(0, slot capacity − booked − buffer).");
line(doc, "Status: gap > 0 → Needs sowing. Gap is 0 and excess > 0 → Saleable excess. Otherwise → Fulfilled.");
line(doc, "Seed plan = the seed source that appears on the most pipeline orders in that window. If there are no orders, it shows Company.");

h(doc, "Case 1 — Needs sowing");
{
  const gap = 10000;
  const excess = 0;
  const status = capacityStatusLabel(capacityStatus({ gap, excess }));
  example(doc, "Tomato Abhinav  ·  17-10-2026 → 19-10-2026", [
    "Capacity 24,000. Buffer 0. Booked 24,000. Sowed (sowingDone) 14,000.",
    "Gap = 24,000 − 14,000 = 10,000.",
    "Nothing left after order cover, so excess = 0.",
    `Can book = max(0, 24,000 − 24,000 − 0) = ${canBookPlants(24000, 24000, 0).toLocaleString("en-IN")}.`,
    `Status = ${status}.`,
    "On screen: orange Needs sowing. Click the gap number to open orders that are still not sowed.",
  ]);
}

h(doc, "Case 2 — Needs sowing and excess on the same slot");
{
  const status = capacityStatusLabel(capacityStatus({ gap: 3000, excess: 7000 }));
  example(doc, "Gap wins over excess", [
    "Booked 24,000. Sowed (covered) 21,000. Gap = 3,000.",
    "Physical sow left 7,000 plants that are not reserved for those orders. Excess = 7,000.",
    `Status = ${status}, because gap is still above 0.`,
    "Saleable excess is not the status until the gap is 0.",
  ]);
}

h(doc, "Case 3 — Saleable excess");
{
  const status = capacityStatusLabel(capacityStatus({ gap: 0, excess: 6500 }));
  example(doc, "Brinjal VNR 212  ·  24-10-2026 → 30-10-2026", [
    "Booked 18,000. All of those orders are sowingDone, so sowed = 18,000 and gap = 0.",
    "The slot was sowed for 24,500 and 18,000 are reserved. Excess = 6,500.",
    `Can book = max(0, 20,000 − 18,000 − 0) = ${canBookPlants(20000, 18000, 0).toLocaleString("en-IN")}.`,
    `Status = ${status}.`,
    "Click excess to see the sowing batches and the leftover plants.",
  ]);
}

h(doc, "Case 4 — Fulfilled");
{
  const status = capacityStatusLabel(capacityStatus({ gap: 0, excess: 0 }));
  example(doc, "Tomato Sakso 3251  ·  18-10-2026 → 20-10-2026", [
    "Booked 20,000. Sowed 20,000. Gap 0. Excess 0.",
    `Can book = max(0, 20,000 − 20,000 − 0) = ${canBookPlants(20000, 20000, 0).toLocaleString("en-IN")}.`,
    `Status = ${status}.`,
    "The slot is full and nothing is left to sell from sowing.",
  ]);
}

h(doc, "Case 5 — Can book with a buffer");
example(doc, "Buffer is held back from new bookings", [
  "Capacity 10,000. Booked 4,000. Buffer amount 1,000.",
  `Can book = max(0, 10,000 − 4,000 − 1,000) = ${canBookPlants(10000, 4000, 1000).toLocaleString("en-IN")}.`,
  "If booked is already above capacity, can book is 0.",
  `Example: capacity 100, booked 200 → ${canBookPlants(100, 200, 0).toLocaleString("en-IN")}.`,
]);

h(doc, "Case 6 — Seed plan");
{
  const raising = majoritySeedPlan([
    { orderStatus: "ACCEPTED", sowingPlan: { seedSource: "RAISING" } },
    { orderStatus: "ACCEPTED", sowingPlan: { seedSource: "RAISING" } },
    { orderStatus: "PENDING", sowingPlan: { seedSource: "COMPANY" } },
    { orderStatus: "CANCELLED", sowingPlan: { seedSource: "COMPANY" } },
  ]);
  const tie = majoritySeedPlan([
    { orderStatus: "ACCEPTED", sowingPlan: { seedSource: "MIXED" } },
    { orderStatus: "READY_FOR_DISPATCH", sowingPlan: { seedSource: "COMPANY" } },
  ]);
  const empty = majoritySeedPlan([]);
  example(doc, "Which seed label is shown", [
    "Two raising orders and one company order. The cancelled company order is ignored.",
    `Majority = ${raising}. The row shows Raising.`,
    `One mixed order and one company order is a tie at 1. Company is kept because it is already ahead. Result = ${tie}.`,
    `No orders at all → ${empty} (Company).`,
    "Company = nursery seed. Raising = farmer seed. Mixed = both on that order.",
  ]);
}

ensure(doc, 140);
h(doc, "Case 7 — Date window");
example(doc, "Sheet range 15-10-2026 to 31-10-2026", [
  `Slot 20-10-2026 → 22-10-2026 overlaps the range: ${slotOverlapsRange("20-10-2026", "22-10-2026", from, to)}.`,
  `Slot 01-11-2026 → 05-11-2026 is after the range: ${slotOverlapsRange("01-11-2026", "05-11-2026", from, to)}.`,
  `Slot 01-09-2026 → 10-10-2026 ends before 15 Oct: ${slotOverlapsRange("01-09-2026", "10-10-2026", from, to)}.`,
  "Dates are real calendar days. A text sort of DD-MM-YYYY would put 01-11 before 15-10. The API does not do that.",
  "Presets on the screen: Today, next 7 days, next 14 days (default), this month, or a custom from/to.",
]);

h(doc, "Case 8 — Subtype rollup");
example(doc, "Chilli Armour, three slots in the range", [
  "Slot A: booked 4,000, sowed 4,000, gap 0, excess 0, can book 1,000.",
  "Slot B: booked 6,000, sowed 2,000, gap 4,000, excess 0, can book 0.",
  "Slot C: booked 0, sowed 0, gap 0, excess 0, can book 5,000.",
  "Subtype totals: booked 10,000, sowed 6,000, gap 4,000, excess 0, can book 6,000.",
  "Status = Needs sowing, because the subtype gap is 4,000.",
  "Open the subtype name for the bar page. Grey bar is booked. Green bar is sowed.",
]);

h(doc, "Case 9 — Drawer: orders vs batches");
example(doc, "Click any number on a slot", [
  "The right panel is that slot only.",
  "Orders listed are farmer orders whose booking slot is this slot. Cancelled and rejected orders are omitted. Dealer-quota orders are omitted.",
  "Each order shows order number, farmer, mobile, plants (numberOfPlants + additionalPlants), seed plan, and sowing done or need sow.",
  "Sowing batches show request number, sow date, ready date, plants sowed, packets used, plants covered, and excess plants.",
  "Add order goes to the order screen. Direct sow goes to /u/admin-direct-sow.",
  "A slot can have a sowing gap from delivery-date orders and a different booking-slot order list if an order was booked on one slot and its delivery date sits in another. The sheet numbers follow the delivery window. The order list follows the booking slot.",
]);

h(doc, "Case 10 — Orders that do not count");
example(doc, "Left out of booked, gap, and seed plan", [
  "CANCELLED, REJECTED, TEMPORARY_CANCELLED.",
  "DISPATCHED and COMPLETED are not in the sowing pipeline, so they are not booked or gap.",
  "Dealer quota orders are excluded.",
  "An order with sowingDone true is booked and sowed. It is not gap.",
  "An order with sowingDone false in the pipeline is gap.",
]);

ensure(doc, 160);
h(doc, "Case 11 — Full sheet example");
line(doc, "Range 15-10-2026 to 31-10-2026. These are teaching numbers, not a live export.");
line(doc, "");
const table = [
  ["Subtype", "Seed", "Booked", "Sowed", "Gap", "Excess", "Can book", "Status"],
  ["Abhinav", "Company", "24,000", "14,000", "10,000", "0", "0", "Needs sowing"],
  ["Sakso", "Company", "20,000", "20,000", "0", "0", "0", "Fulfilled"],
  ["Armour", "Raising", "10,000", "6,000", "4,000", "0", "6,000", "Needs sowing"],
  ["VNR 212", "Mixed", "18,000", "18,000", "0", "6,500", "2,000", "Saleable excess"],
];
const cols = [80, 60, 58, 52, 52, 52, 62, 90];
let x0 = 40;
let y = doc.y;
doc.font("Helvetica-Bold").fontSize(8).fillColor("#0f172a");
table[0].forEach((cell, i) => {
  doc.text(cell, x0, y, { width: cols[i] });
  x0 += cols[i];
});
y += 16;
doc.font("Helvetica").fontSize(8);
for (const row of table.slice(1)) {
  x0 = 40;
  row.forEach((cell, i) => {
    doc.text(cell, x0, y, { width: cols[i] });
    x0 += cols[i];
  });
  y += 14;
}
doc.y = y + 8;
line(doc, "Plant total for this example: booked 72,000, sowed 58,000, gap 14,000, excess 6,500, can book 8,000. Status Needs sowing.");

h(doc, "Case 12 — Slot audit (what was checked, not changed)");
example(doc, "Read-only check of sowing-allowed plants", [
  "Script: FINAL_NURSERY_BE/scripts/audit-sowing-allowed-slots.mjs",
  "It compared stored slots with the subtype generator: valid DD-MM-YYYY, inside the subtype start and end, no overlap, no missing day, a slot does not cross a month, length matches slotDays except the last piece of a month.",
  "Result on the live data: 6 plants, 48 subtypes, 26,626 stored slots.",
  "119 booked or sowed slots did not match that pattern. They were not rewritten.",
  "About 10,000 empty expected days are missing, mostly Muskmelon Honey one-day slots. Those were not created.",
]);
example(doc, "Unsafe example — Papaya Taiwan crosses a month", [
  "Stored slot 26-03-2026 → 01-04-2026 has orders or sowing.",
  "The generator would stop at the month end (31-03-2026) and start a new slot on 01-04-2026.",
  "Because the slot is already booked or sowed, the audit only reports it. The capacity sheet still shows the stored dates.",
]);
example(doc, "Unsafe example — slot outside the generated pattern", [
  "Papaya R15 slot 09-04-2026 → 15-04-2026 is stored and has activity.",
  "It does not match the start, length, and month-end sequence implied by that subtype’s slotDays and date range.",
  "Same rule: report, do not rewrite.",
]);
example(doc, "Empty example — expected day missing", [
  "Muskmelon Honey is configured as 1-day slots.",
  "01-01-2026 → 01-01-2026 is expected and is not stored.",
  "No orders and no sowing sit on that missing day, so a later repair could add it. That repair was not run.",
]);

h(doc, "What each screen action does");
line(doc, "Today / Next 7 / Next 14 / This month / Custom — reloads the sheet for that delivery range.");
line(doc, "Search — filters the loaded plants and subtypes by name. It does not change the numbers.");
line(doc, "Expand a subtype — shows each slot in the range.");
line(doc, "Click a number — opens the slot drawer.");
line(doc, "Click the subtype name — opens the bar page for that variety in the same date range.");
line(doc, "Add order / Direct sow — existing screens. This sheet does not create the order or the sow by itself.");

doc.end();

await new Promise((resolve, reject) => {
  doc.on("end", resolve);
  doc.on("error", reject);
});
console.log(outPath);
