/**
 * Rename / merge the batch masters to the owner's canonical batch list (scripts/lib/batchNames.mjs).
 *
 *   node scripts/apply-rename-batches-2026-10-05.mjs                              # DRY RUN (reads only)
 *   CONFIRM_PROD=YES node scripts/apply-rename-batches-2026-10-05.mjs --apply
 *
 * - single master          -> renamed (everything else points to it by id, so nothing else changes)
 * - several masters, 1 name -> MERGED: one survivor keeps the name. The others' stock lines + outward rows
 *   are moved into the survivor's PlantOutward (ids and quantities untouched, an activity-log row is added),
 *   FIFO ledgers are combined, every reference in the database (orders, dispatches, slot logs ...)
 *   is re-pointed, and only then are the emptied masters / outward docs / ledgers deleted.
 * - text snapshots ("batchNumber": "SB-68" next to a batch id) are relabelled to the new name.
 * Everything runs in ONE transaction after a full JSON backup. A final check proves that total stock,
 * shed totals and line count are identical before and after.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import "../models/farmer.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import SecondaryDispatchAvailability from "../models/secondaryDispatchAvailability.model.js";
import { loadShedStockPayload } from "../services/capacityShedStock.service.js";
import { canonicalName, CANONICAL } from "./lib/batchNames.mjs";
import { refreshSecondarySummary } from "./lib/poSummary.mjs";
import { fmt, flattenSystem } from "./lib/paperReconcile.mjs";

const APPLY = process.argv.includes("--apply");
if (APPLY && process.env.CONFIRM_PROD !== "YES") throw new Error("Refusing to write PROD: set CONFIRM_PROD=YES together with --apply");
const url = process.env.PROD_MONGO_URL;
if (!url) throw new Error("PROD_MONGO_URL missing");

const SOURCE = "rename-batches-2026-10-05";
const { ObjectId } = mongoose.Types;
const SKIP_COLLECTIONS = new Set([
  DispatchBatch.collection.collectionName,
  PlantOutward.collection.collectionName,
  SecondaryDispatchAvailability.collection.collectionName,
]);

await mongoose.connect(url, { serverSelectionTimeoutMS: 15000, ...(APPLY ? {} : { readPreference: "secondaryPreferred" }) });
const db = mongoose.connection.db;
console.log(APPLY ? "=== APPLY on PROD ===" : "=== DRY RUN (no writes) ===", "db:", db.databaseName);

const BATCH = DispatchBatch.collection;
const PO = PlantOutward.collection;
const LED = SecondaryDispatchAvailability.collection;

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
const HEX24 = /^[a-f0-9]{24}$/;
const isOid = (v) => v && (v._bsontype === "ObjectId" || v._bsontype === "ObjectID");
const summarize = (payload) => {
  const lines = flattenSystem(payload);
  const perShed = {};
  for (const l of lines) perShed[l.shed] = (perShed[l.shed] || 0) + l.remaining;
  return { remaining: lines.reduce((s, l) => s + l.remaining, 0), lines: lines.length, perShed };
};

function collectOids(v, acc) {
  if (v == null) return;
  if (Array.isArray(v)) return v.forEach((x) => collectOids(x, acc));
  if (isOid(v)) return void acc.add(String(v));
  if (typeof v === "string") return void (HEX24.test(v) && acc.add(v)); // some collections store ids as strings
  if (v._bsontype || v instanceof Date || Buffer.isBuffer(v) || typeof v !== "object") return;
  for (const x of Object.values(v)) collectOids(x, acc);
}

async function allCollections() {
  const cols = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system.") && !SKIP_COLLECTIONS.has(n));
  return cols.sort();
}

// ---------------------------------------------------------------------------------------------
// read current state
// ---------------------------------------------------------------------------------------------
const masters = await BATCH.find({}).toArray();
const poDocs = await PO.find({}).toArray();
const ledgers = await LED.find({}).toArray();
const poByBatch = new Map();
for (const p of poDocs) {
  const k = String(p.batchId);
  if (poByBatch.has(k)) throw new Error(`Batch ${k} has more than one PlantOutward document - not handled`);
  poByBatch.set(k, p);
}
const ledByBatch = new Map(ledgers.map((l) => [String(l.dispatchBatchId), l]));

const before = await loadShedStockPayload();
const beforeTotals = summarize(before);
console.log(`masters ${masters.length}, outward docs ${poDocs.length}, ledgers ${ledgers.length}`);
console.log(`stock before: ${fmt(beforeTotals.remaining)} plants on ${beforeTotals.lines} lines in ${Object.keys(beforeTotals.perShed).length} sheds`);

// ---------------------------------------------------------------------------------------------
// references to every master (all collections) - used to pick the survivor and to verify
// ---------------------------------------------------------------------------------------------
const masterIds = new Set(masters.map((m) => String(m._id)));
const poIds = new Set(poDocs.map((p) => String(p._id)));
const watch = new Set([...masterIds, ...poIds]);
const refCount = new Map(); // id -> docs
const refsByCollection = new Map(); // collection -> docs touching any master/PO id
for (const col of await allCollections()) {
  let n = 0;
  let hits = 0;
  for await (const doc of db.collection(col).find({})) {
    n++;
    const acc = new Set();
    collectOids(doc, acc);
    let touched = false;
    for (const id of acc)
      if (watch.has(id)) {
        refCount.set(id, (refCount.get(id) || 0) + 1);
        touched = true;
      }
    if (touched) hits++;
  }
  if (hits) refsByCollection.set(col, { docs: n, touching: hits });
}
console.log("collections that reference batches:", Object.fromEntries([...refsByCollection].map(([c, v]) => [c, `${v.touching}/${v.docs}`])));

// ---------------------------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------------------------
const info = masters.map((m) => {
  const id = String(m._id);
  const po = poByBatch.get(id);
  return {
    m,
    id,
    old: m.batchNumber,
    canon: canonicalName(m.batchNumber),
    lines: (po?.secondaryInward || []).length,
    hasPrimary: (po?.outward || []).length > 0, // genuine sowing/primary data must stay on the survivor
    refs: (refCount.get(id) || 0) + (po ? refCount.get(String(po._id)) || 0 : 0),
  };
});
const groups = new Map();
for (const x of info.filter((i) => i.canon)) groups.set(x.canon, [...(groups.get(x.canon) || []), x]);

// collisions: a canonical name already used by a master that is NOT part of that group
for (const [canon, g] of groups) {
  const clash = masters.find((m) => m.batchNumber === canon && !g.some((x) => x.id === String(m._id)));
  if (clash) throw new Error(`Name "${canon}" is already used by another batch (${clash._id})`);
}

const idMap = new Map(); // removed master id -> survivor id
const poMap = new Map(); // removed PO id -> survivor PO id
const nameMap = new Map(); // old name -> { canon, ids:Set(old id, survivor id) }
const plan = []; // { canon, survivor, removed[], renameOnly }
for (const [canon, g] of groups) {
  const sorted = [...g].sort((a, b) => Number(b.hasPrimary) - Number(a.hasPrimary) || b.refs + b.lines - (a.refs + a.lines) || a.old.localeCompare(b.old));
  const survivor = sorted[0];
  const removed = sorted.slice(1);
  plan.push({ canon, survivor, removed, rename: survivor.old !== canon });
  for (const x of g) {
    if (x.old !== canon) nameMap.set(x.old, { canon, ids: new Set([x.id, survivor.id]) });
  }
  for (const r of removed) {
    idMap.set(r.id, survivor.id);
    const rp = poByBatch.get(r.id);
    const sp = poByBatch.get(survivor.id);
    if (rp) {
      if (!sp) throw new Error(`Survivor ${survivor.old} has no outward document`);
      poMap.set(String(rp._id), String(sp._id));
      for (const k of ["outward", "primaryInward", "primaryOutward"])
        if ((rp[k] || []).length) throw new Error(`${r.old}: ${k} is not empty - merge not supported`);
    }
  }
}

console.log("\n--- PLAN ---");
for (const p of plan) {
  const act = p.removed.length ? `MERGE ${p.removed.length + 1} -> 1` : p.rename ? "RENAME" : "already correct";
  console.log(`${p.canon.padEnd(9)} ${act.padEnd(14)} keep ${p.survivor.old}${p.removed.length ? "   merge away: " + p.removed.map((r) => `${r.old} (${r.lines} lines)`).join(", ") : ""}`);
}
console.log("left untouched:", info.filter((i) => !i.canon).map((i) => i.old).join(", "));

// ---------------------------------------------------------------------------------------------
// reference rewrite (pure)
// ---------------------------------------------------------------------------------------------
function rw(v) {
  if (v == null) return [v, false];
  if (Array.isArray(v)) {
    let ch = false;
    const out = v.map((x) => {
      const [y, c] = rw(x);
      if (c) ch = true;
      return y;
    });
    return [ch ? out : v, ch];
  }
  if (isOid(v)) {
    const t = idMap.get(String(v)) ?? poMap.get(String(v));
    return t ? [new ObjectId(t), true] : [v, false];
  }
  if (typeof v === "string") {
    const t = HEX24.test(v) ? idMap.get(v) ?? poMap.get(v) : null;
    return t ? [t, true] : [v, false];
  }
  if (v._bsontype || v instanceof Date || Buffer.isBuffer(v) || typeof v !== "object") return [v, false];
  let ch = false;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const [y, c] = rw(x);
    out[k] = y;
    if (c) ch = true;
  }
  if (typeof out.batchNumber === "string" && nameMap.has(out.batchNumber)) {
    const meta = nameMap.get(out.batchNumber);
    const sib = [out.batchId, out.dispatchBatchId, v.batchId, v.dispatchBatchId].filter(Boolean).map(String);
    const sameBatch = sib.some((s) => meta.ids.has(s));
    if (!/^\d+$/.test(out.batchNumber) || sameBatch) {
      out.batchNumber = meta.canon;
      ch = true;
    }
  }
  return [ch ? out : v, ch];
}
function rewriteDoc(doc) {
  const set = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "_id") continue;
    const [y, c] = rw(v);
    if (c) set[k] = y;
  }
  return Object.keys(set).length ? set : null;
}

// which docs would change?
const targets = []; // { col, _id }
for (const col of await allCollections()) {
  for await (const doc of db.collection(col).find({})) {
    if (rewriteDoc(doc)) targets.push({ col, _id: doc._id });
  }
}
const targetsByCol = targets.reduce((m, t) => ((m[t.col] = (m[t.col] || 0) + 1), m), {});
console.log("\ndocuments whose batch references / labels will be updated:", targetsByCol);

const movedLines = plan.reduce((s, p) => s + p.removed.reduce((a, r) => a + r.lines, 0), 0);
console.log(`stock lines moved: ${movedLines}; masters deleted: ${plan.reduce((s, p) => s + p.removed.length, 0)}; renamed: ${plan.filter((p) => p.rename).length}`);

if (!APPLY) {
  console.log("\nRe-run with  CONFIRM_PROD=YES ... --apply  to write PROD.");
  await mongoose.disconnect();
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------------------------
const dir = path.resolve("..", "dryrun-reports");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupFile = path.join(dir, `backup-before-rename-${stamp}.json`);
const preImages = [];
for (const t of targets) preImages.push({ col: t.col, doc: await db.collection(t.col).findOne({ _id: t._id }) });
fs.writeFileSync(
  backupFile,
  JSON.stringify({ masters, plantOutwards: poDocs.filter((p) => [...groups.values()].flat().some((g) => String(g.m._id) === String(p.batchId))), ledgers, preImages })
);
console.log("backup written:", backupFile, `(${(fs.statSync(backupFile).size / 1e6).toFixed(1)} MB)`);

// ---------------------------------------------------------------------------------------------
// apply (one transaction)
// ---------------------------------------------------------------------------------------------
const session = await mongoose.startSession();
try {
  session.startTransaction({ maxCommitTimeMS: 180000 });
  const now = new Date();

  // 1. move stock lines + combine ledgers
  for (const p of plan) {
    if (!p.removed.length) continue;
    const S = p.survivor;
    const poS = await PO.findOne({ batchId: S.m._id }, { session });
    for (const R of p.removed) {
      const poR = await PO.findOne({ batchId: R.m._id }, { session });
      let movedPlants = 0;
      if (poR) {
        const inward = (poR.secondaryInward || []).map((si) => {
          movedPlants += Number(si.availableQuantity) || 0;
          return {
            ...si,
            activityLog: [
              ...(si.activityLog || []),
              {
                _id: new ObjectId(),
                action: "BATCH_MERGED",
                activityName: `Batch name unified · ${R.old} → ${p.canon}`,
                performedAt: now,
                quantity: Number(si.availableQuantity) || 0,
                previousValue: { batchNumber: R.old },
                newValue: { batchNumber: p.canon, source: SOURCE },
                reason: "Batch names unified to the owner's batch list",
              },
            ],
          };
        });
        const outward = poR.secondaryOutward || [];
        if (inward.length || outward.length)
          await PO.updateOne({ _id: poS._id }, { $push: { secondaryInward: { $each: inward }, secondaryOutward: { $each: outward } } }, { session });
      }
      const lr = await LED.findOne({ dispatchBatchId: R.m._id }, { session });
      const ls = await LED.findOne({ dispatchBatchId: S.m._id }, { session });
      if (lr) {
        if (!ls) {
          await LED.updateOne(
            { _id: lr._id },
            { $set: { dispatchBatchId: S.m._id, plantOutwardId: poS._id, fifoLines: (lr.fifoLines || []).map((f) => ({ ...f, plantOutwardId: poS._id })) } },
            { session }
          );
        } else {
          const fifo = [...(ls.fifoLines || []), ...(lr.fifoLines || []).map((f) => ({ ...f, plantOutwardId: poS._id }))].sort(
            (a, b) => new Date(a.secondaryInwardDate) - new Date(b.secondaryInwardDate)
          );
          const total = fifo.reduce((s, f) => s + Math.max(0, Number(f.remainingPlants) || 0), 0);
          const trail = [
            { action: "ADJUST", activityName: `Batch merge · ${R.old} → ${p.canon}`, quantity: Math.max(0, movedPlants), previousTotalAvailable: ls.totalAvailablePlants || 0, newTotalAvailable: total, reason: "Batch names unified to the owner's batch list", plantOutwardId: poS._id, createdAt: now },
            ...[...(ls.availabilityTrail || []), ...(lr.availabilityTrail || []).map((t) => ({ ...t, plantOutwardId: t.plantOutwardId ? poS._id : t.plantOutwardId }))].sort(
              (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
            ),
          ];
          await LED.updateOne({ _id: ls._id }, { $set: { fifoLines: fifo, totalAvailablePlants: total, availabilityTrail: trail } }, { session });
          await LED.deleteOne({ _id: lr._id }, { session });
        }
      }
    }
  }

  // 2. re-point every reference / relabel snapshots
  let rewritten = 0;
  for (const t of targets) {
    const doc = await db.collection(t.col).findOne({ _id: t._id }, { session });
    const set = doc && rewriteDoc(doc);
    if (set) {
      await db.collection(t.col).updateOne({ _id: t._id }, { $set: set }, { session });
      rewritten++;
    }
  }

  // 3. prove nothing still points at what is about to be deleted
  const doomed = new Set([...idMap.keys(), ...poMap.keys()]);
  if (doomed.size) {
    for (const col of await allCollections()) {
      for await (const doc of db.collection(col).find({}, { session })) {
        const acc = new Set();
        collectOids(doc, acc);
        for (const id of acc) if (doomed.has(id)) throw new Error(`Still referenced: ${col} ${doc._id} -> ${id}`);
      }
    }
    // other batches' outward docs / ledgers must not reference them either
    for (const x of await PO.find({}, { session }).toArray()) {
      if (poMap.has(String(x._id)) || idMap.has(String(x.batchId))) continue;
      const acc = new Set();
      collectOids(x, acc);
      for (const id of acc) if (doomed.has(id)) throw new Error(`Still referenced from outward doc ${x._id} -> ${id}`);
    }
  }

  // 4. delete the emptied masters / outward docs
  for (const p of plan)
    for (const R of p.removed) {
      await PO.deleteMany({ batchId: R.m._id }, { session });
      await LED.deleteMany({ dispatchBatchId: R.m._id }, { session });
      await BATCH.deleteOne({ _id: R.m._id }, { session });
    }

  // 5. rename survivors / single masters, refresh the secondary totals of merged outward docs
  for (const p of plan) {
    if (p.rename) await BATCH.updateOne({ _id: p.survivor.m._id }, { $set: { batchNumber: p.canon, updatedAt: now } }, { session });
    if (p.removed.length) {
      const poS = await PO.findOne({ batchId: p.survivor.m._id }, { session });
      await refreshSecondarySummary(PlantOutward, poS._id, session);
    }
  }

  await session.commitTransaction();
  console.log(`\ncommitted. reference documents updated: ${rewritten}`);
} catch (err) {
  await session.abortTransaction();
  console.error("\nFAILED - transaction rolled back, nothing was written:", err);
  process.exitCode = 1;
  await session.endSession();
  await mongoose.disconnect();
  process.exit(1);
} finally {
  await session.endSession().catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------------------------
const after = await loadShedStockPayload();
const afterTotals = summarize(after);
console.log(`\nstock after : ${fmt(afterTotals.remaining)} plants on ${afterTotals.lines} lines   (before: ${fmt(beforeTotals.remaining)} on ${beforeTotals.lines})`);
let bad = 0;
for (const shed of new Set([...Object.keys(beforeTotals.perShed), ...Object.keys(afterTotals.perShed)])) {
  if ((beforeTotals.perShed[shed] || 0) !== (afterTotals.perShed[shed] || 0)) {
    bad++;
    console.log("  SHED TOTAL CHANGED:", shed, beforeTotals.perShed[shed], "->", afterTotals.perShed[shed]);
  }
}
const names = (await BATCH.find({}).toArray()).map((m) => m.batchNumber);
const dup = names.filter((n, i) => names.indexOf(n) !== i);
console.log("batch masters now:", names.length, "| duplicate names:", dup.length ? dup.join(",") : "none");
console.log("names:", names.sort().join(" | "));
console.log(afterTotals.remaining === beforeTotals.remaining && afterTotals.lines === beforeTotals.lines && !bad ? "\nCHECK OK: stock and line count identical before/after." : "\n!! CHECK FAILED - compare with the backup");
await mongoose.disconnect();
