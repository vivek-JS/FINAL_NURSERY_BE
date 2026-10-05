/**
 * READ-ONLY dry run: rename / merge the batch masters to the owner's canonical batch list.
 * Writes nothing. Reports what would be renamed, which batches would be merged into one,
 * which new batches are needed, and how many records point at each batch.
 *
 *   node scripts/dryrun-rename-batches.mjs
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import XLSX from "xlsx";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import SecondaryDispatchAvailability from "../models/secondaryDispatchAvailability.model.js";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import Sowing from "../models/sowing.model.js";
import SlotReadyRollLog from "../models/slotReadyRollLog.model.js";
import PlantSlot from "../models/slots.model.js";
import { canonicalName, ASSUMED, CANONICAL } from "./lib/batchNames.mjs";
import { PAPER } from "./data/paper-stock-2026-10-04.mjs";
import { fmt } from "./lib/paperReconcile.mjs";

const url = process.env.PROD_MONGO_URL;
if (!url) throw new Error("PROD_MONGO_URL missing");
await mongoose.connect(url, { serverSelectionTimeoutMS: 15000, readPreference: "secondaryPreferred" });

const masters = await DispatchBatch.find({}).lean();
const idToName = new Map(masters.map((m) => [String(m._id), m.batchNumber]));
const nameSet = new Set(masters.map((m) => m.batchNumber));

// ---- stock lines / ledger per master
const pos = await PlantOutward.find({}).select("batchId secondaryInward._id secondaryInward.availableQuantity secondaryOutward._id").lean();
const poBy = new Map();
for (const p of pos) {
  const k = String(p.batchId);
  const cur = poBy.get(k) || { docs: 0, inward: 0, outward: 0, stock: 0 };
  cur.docs += 1;
  cur.inward += (p.secondaryInward || []).length;
  cur.outward += (p.secondaryOutward || []).length;
  cur.stock += (p.secondaryInward || []).reduce((s, x) => s + (Number(x.availableQuantity) || 0), 0);
  poBy.set(k, cur);
}
const ledgers = new Set((await SecondaryDispatchAvailability.find({}).select("dispatchBatchId").lean()).map((l) => String(l.dispatchBatchId)));

// ---- references from other collections (by id = safe on rename, by text snapshot = historical label)
const refs = {}; // masterId -> { Collection: {id: n, name: n} }
const bump = (id, col, kind) => {
  refs[id] ||= {};
  refs[id][col] ||= { id: 0, name: 0 };
  refs[id][col][kind] += 1;
};
function walk(v, key, hitIds, hitNames) {
  if (v == null) return;
  if (Array.isArray(v)) return v.forEach((x) => walk(x, key, hitIds, hitNames));
  if (v._bsontype === "ObjectId" || v instanceof mongoose.Types.ObjectId) {
    const s = String(v);
    if (idToName.has(s)) hitIds.add(s);
    return;
  }
  if (typeof v === "string") {
    if (key === "batchNumber" && nameSet.has(v)) hitNames.add(v);
    return;
  }
  if (v instanceof Date || typeof v !== "object") return;
  for (const [k, x] of Object.entries(v)) walk(x, k, hitIds, hitNames);
}
const nameToId = new Map(masters.map((m) => [m.batchNumber, String(m._id)]));
const scanTargets = [
  ["Dispatch", Dispatch],
  ["Order", Order],
  ["Sowing", Sowing],
  ["SlotReadyRollLog", SlotReadyRollLog],
  ["PlantSlot", PlantSlot],
];
const scanned = {};
for (const [label, Model] of scanTargets) {
  let n = 0;
  const cur = Model.collection.find({});
  for await (const doc of cur) {
    n++;
    const hi = new Set();
    const hn = new Set();
    walk(doc, "", hi, hn);
    hi.forEach((id) => bump(id, label, "id"));
    hn.forEach((nm) => bump(nameToId.get(nm), label, "name"));
  }
  scanned[label] = n;
}
await mongoose.disconnect();

const refTotal = (id, kind) => Object.values(refs[id] || {}).reduce((s, c) => s + c[kind], 0);
const refText = (id) =>
  Object.entries(refs[id] || {})
    .map(([c, v]) => `${c}${v.id ? ` id×${v.id}` : ""}${v.name ? ` name×${v.name}` : ""}`)
    .join(", ");

// ---- plan
const plan = masters.map((m) => {
  const id = String(m._id);
  const po = poBy.get(id) || { docs: 0, inward: 0, outward: 0, stock: 0 };
  return {
    id,
    old: m.batchNumber,
    canon: canonicalName(m.batchNumber),
    plant: `${m.plantCmsId}/${m.plantSubtypeId}`,
    lines: po.inward,
    outwards: po.outward,
    stock: po.stock,
    ledger: ledgers.has(id),
    refId: refTotal(id, "id"),
    refName: refTotal(id, "name"),
    refText: refText(id),
    assumed: ASSUMED.has(m.batchNumber),
  };
});

const groups = new Map();
for (const p of plan.filter((x) => x.canon)) groups.set(p.canon, [...(groups.get(p.canon) || []), p]);
const notInList = plan.filter((p) => !p.canon);

console.log("\n===== DRY RUN (READ ONLY) – batch rename / merge to the owner's batch list =====");
console.log("scanned documents:", scanned);
console.log(`batch masters now: ${masters.length}    →  after: ${groups.size} named batches + ${notInList.length} left as they are`);

const resultRows = [];
const newNames = new Set();
for (const t of PAPER) for (const l of t.lines) newNames.add(l.batch);

console.log("\n--- 1. EACH OF YOUR BATCH NAMES ---");
for (const name of CANONICAL) {
  const g = groups.get(name) || [];
  const survivor = [...g].sort((a, b) => b.refId + b.lines - (a.refId + a.lines) || a.old.localeCompare(b.old))[0];
  const action = !g.length ? "CREATE (new batch)" : g.length === 1 ? (g[0].old === name ? "already correct" : "RENAME") : "MERGE";
  const compat = new Set(g.map((x) => x.plant)).size <= 1;
  console.log(`\n${name.padEnd(9)} ${action}${g.length > 1 ? `  (${g.length} batches become one)` : ""}${compat ? "" : "   !! different plant/subtype – check"}`);
  for (const x of g) {
    const isSurv = g.length > 1 && x === survivor;
    console.log(
      `    ${x.old.padEnd(28)} ${isSurv ? "[kept, renamed]" : g.length > 1 ? "[merged into it]" : ""}`.padEnd(62),
      `lines ${String(x.lines).padStart(3)}  outward ${String(x.outwards).padStart(3)}  stock ${fmt(x.stock).padStart(8)}  ledger ${x.ledger ? "yes" : "no "}  refs by id ${String(x.refId).padStart(3)}  by text ${String(x.refName).padStart(3)}${x.assumed ? "   (my assumption)" : ""}`
    );
    if (x.refText) console.log(`        refs: ${x.refText}`);
    resultRows.push({
      "New name": name,
      Action: action,
      "Current batch": x.old,
      "Kept or merged": g.length > 1 ? (isSurv ? "kept (renamed)" : "merged into it") : action === "already correct" ? "same" : "renamed",
      "Stock lines": x.lines,
      "Outward rows": x.outwards,
      "Stock now": x.stock,
      "Has ledger": x.ledger ? "yes" : "no",
      "Records by id": x.refId,
      "Records by name text": x.refName,
      "Where used": x.refText,
      "My assumption": x.assumed ? "yes" : "",
    });
  }
}

const extra = [...newNames].filter((n) => !CANONICAL.includes(n));
console.log("\n--- 2. NEW BATCHES (not in the system, and not in your list) ---");
for (const n of extra) console.log(`   ${n}   (used by the paper; will be created. Tell me if this should be one of your listed names instead)`);

console.log("\n--- 3. BATCHES NOT IN YOUR LIST (left untouched) ---");
for (const p of notInList)
  console.log(`   ${p.old.padEnd(24)} lines ${p.lines}  stock ${fmt(p.stock)}  refs by id ${p.refId}${p.refText ? "  (" + p.refText + ")" : ""}`);

const merges = [...groups.entries()].filter(([, g]) => g.length > 1);
console.log("\n--- 4. WHAT A MERGE HAS TO MOVE ---");
let moveLines = 0;
let moveRefs = 0;
for (const [name, g] of merges) {
  const survivor = [...g].sort((a, b) => b.refId + b.lines - (a.refId + a.lines) || a.old.localeCompare(b.old))[0];
  const others = g.filter((x) => x !== survivor);
  const l = others.reduce((s, x) => s + x.lines, 0);
  const o = others.reduce((s, x) => s + x.outwards, 0);
  const r = others.reduce((s, x) => s + x.refId, 0);
  moveLines += l;
  moveRefs += r;
  console.log(`   ${name.padEnd(8)} keep ${survivor.old}; move ${l} stock lines + ${o} outward rows + re-point ${r} records from ${others.map((x) => x.old).join(", ")}`);
}
console.log(`   total: ${merges.length} merge groups, ${moveLines} stock lines to move, ${moveRefs} records to re-point`);

const dir = path.resolve("..", "dryrun-reports");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "dryrun-batch-rename-2026-10-05.xlsx");
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resultRows), "Rename-merge plan");
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.json_to_sheet([
    ...extra.map((n) => ({ Batch: n, Note: "new batch, not in your list" })),
    ...notInList.map((p) => ({ Batch: p.old, Note: `not in your list – left as is (lines ${p.lines}, stock ${p.stock}, refs ${p.refId})` })),
  ]),
  "Not in list"
);
XLSX.writeFile(wb, file);
console.log("\nreport written:", file);
