/**
 * Bring PROD shed / batch stock in line with the paper notebook "STOCK AS ON 4/10/26".
 *
 *   node scripts/apply-paper-shed-stock-2026-10-04.mjs                      # DRY RUN (default, reads only)
 *   CONFIRM_PROD=YES node scripts/apply-paper-shed-stock-2026-10-04.mjs --apply
 *
 * Options
 *   --only=Rajgad,Torna     only touch sheds whose name contains one of these (case-insensitive)
 *   --include-panhalgad     also zero the shed that is not on paper (default: left alone)
 *
 * What it does (paper is the truth)
 *   - paper < system : the lagwad line(s) get a "stock correction" row in transferHistory (history kept,
 *                      oldest line first), booking-slot synced stock and the FIFO ledger are reduced to match.
 *   - paper > system : a NEW lagwad line is created on the matching batch.
 *                        dated paper line   -> lagwad on the date written on paper
 *                        undated paper line -> lagwad (as-on date - ready days), ready on the as-on date
 *   - batch in wrong shed (SB178) : lagwad line is moved to the paper's shed.
 *   Everything is done in ONE transaction. A JSON backup of every touched document is written first.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import moment from "moment";
import "../models/farmer.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantSlot from "../models/slots.model.js";
import SecondaryDispatchAvailability from "../models/secondaryDispatchAvailability.model.js";
import { loadShedStockPayload } from "../services/capacityShedStock.service.js";
import {
  expectedReadyDateForSecondarySize,
  syncSecondaryInwardSlotStockAdd,
  resolveBookingSlotIdForSecondaryBatch,
  secondaryInwardCalendarReady,
} from "../services/secondaryShedSlotStock.service.js";
import { recordSecondaryInwardOnLedger } from "../services/secondaryDispatchAvailability.service.js";
import { recordShedActivity, SHED_ACTIVITY_ACTIONS } from "../services/shedActivity.service.js";
import { splitLagwadQtyForSlot, maxLagwadSyncedPlants } from "../utility/lagwadSlotPlantsSplit.js";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";
import { PAPER, AS_ON } from "./data/paper-stock-2026-10-04.mjs";
import { reconcile, fmt, short, shiftDay } from "./lib/paperReconcile.mjs";
import { canonicalName, isVasai } from "./lib/batchNames.mjs";
import { refreshSecondarySummary } from "./lib/poSummary.mjs";

const APPLY = process.argv.includes("--apply");
const INCLUDE_PANHALGAD = process.argv.includes("--include-panhalgad");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "")
  .replace("--only=", "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const SOURCE = "paper-stock-2026-10-04";
const REASON = `Stock correction to physical count (notebook, as on ${AS_ON})`;
const SIZE = "R1";
const CAVITY = 126;
const G9_TEMPLATE_BATCH = "424";
const BANANA_PLANT_ID = "68fdf6d45832d541b274acfa";
const SUBTYPE_VASAI = "68fdf6d45832d541b274acfc";
const SUBTYPE_G9 = "6944c7e75845df7093731ba2";

if (APPLY && process.env.CONFIRM_PROD !== "YES") {
  throw new Error("Refusing to write PROD: set CONFIRM_PROD=YES together with --apply");
}
const url = process.env.PROD_MONGO_URL;
if (!url) throw new Error("PROD_MONGO_URL missing");

const today = moment().startOf("day");
const nameOfShed = (s) => String(s || "").toLowerCase();

// ------------------------------------------------------------------------------------------------
// plan
// ------------------------------------------------------------------------------------------------
function allocateReduce(lines, amount) {
  const live = lines.filter((l) => l.remaining > 0).sort((a, b) => String(a.lagwad).localeCompare(String(b.lagwad)) || a.batch.localeCompare(b.batch));
  const exact = live.find((l) => l.remaining === amount);
  if (exact) return [{ line: exact, amount }];
  const out = [];
  let left = amount;
  for (const l of live) {
    if (left <= 0) break;
    const take = Math.min(l.remaining, left);
    out.push({ line: l, amount: take });
    left -= take;
  }
  if (left > 0) throw new Error(`Cannot reduce ${amount}: only ${amount - left} available on ${lines.map((l) => l.batch).join(",")}`);
  return out;
}

function buildOps(rows, sysLines) {
  const ops = [];
  for (const r of rows) {
    const shedKey = r.sysShed || r.shed;
    if (ONLY.length && !ONLY.some((s) => nameOfShed(shedKey).includes(s))) continue;
    const op = r.op;
    if (op.kind === "skip-shed") {
      if (INCLUDE_PANHALGAD) for (const l of op.lines) ops.push({ type: "reduce", row: r, line: l, amount: l.remaining });
      continue;
    }
    if (op.kind === "move") {
      for (const l of op.lines) ops.push({ type: "move", row: r, line: l, toShed: op.toShed });
      if (op.then.delta !== 0) throw new Error(`Move + qty change not supported for ${r.item}`);
      continue;
    }
    if (op.delta < 0) {
      for (const a of allocateReduce(op.lines, -op.delta)) ops.push({ type: "reduce", row: r, line: a.line, amount: a.amount });
    } else if (op.delta > 0) {
      ops.push(planAdd(r));
    }
  }
  return ops;
}

function planAdd(r) {
  const op = r.op;
  const shed = r.sysShed;
  if (!shed) throw new Error(`No system shed for paper shed ${r.shed}`);
  if (op.kind === "dated") {
    if (op.pl.dates.length !== 1) throw new Error(`Cannot create entry for multi-date line ${r.item}`);
    return { type: "add", row: r, shed, plants: op.delta, lagwad: op.pl.dates[0], batch: op.batch };
  }
  return { type: "add", row: r, shed, plants: op.delta, lagwad: null, batch: op.batch };
}

// ------------------------------------------------------------------------------------------------
// slot helpers (same fields as the existing lagwad flows touch)
// ------------------------------------------------------------------------------------------------
async function loadSlot(slotId, session) {
  if (!slotId || !mongoose.isValidObjectId(String(slotId))) return null;
  const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId }).session(session || null);
  if (!plantSlot) return null;
  for (const st of plantSlot.subtypeSlots || []) {
    const slot = st.slots.id(slotId);
    if (slot) return { plantSlot, slot };
  }
  return null;
}

/**
 * NOTE: the stored availableQuantity (what the system shows, and what the booking-slot sync is based on)
 * can differ from totalQuantity - sum(transferHistory) on older lines. PlantOutward.save() would silently
 * recompute it from history for EVERY line of the batch, so this script never calls save() on existing
 * batches - it uses targeted updateOne writes and treats the stored value as the baseline.
 * The correction row written to transferHistory also covers such drift, so a later save() cannot
 * bring removed plants back.
 */
function planReduceNumbers(si, batchLean, amount) {
  const total = Number(si.totalQuantity) || 0;
  const hist = (si.transferHistory || []).reduce((s, t) => s + (Number(t.quantityTransferred) || 0), 0);
  const computed = Math.max(0, total - hist);
  const avail0 = si.availableQuantity != null ? Math.max(0, Number(si.availableQuantity) || 0) : computed;
  if (amount > avail0) throw new Error(`Reduce ${amount} > available ${avail0} on line ${si._id}`);
  const avail1 = avail0 - amount;
  const histQty = Math.max(amount, computed - avail1);
  const drift = computed - avail0;
  const synced0 = Math.max(0, Number(si.slotStockSyncedPlants) || 0);
  const synced1 = Math.min(synced0, maxLagwadSyncedPlants(avail1));
  const excess = synced0 - synced1;
  const split0 = splitLagwadQtyForSlot(avail0);
  const mortDec = split0.actualPlants > 0 ? Math.round((split0.expectedMortality * excess) / split0.actualPlants) : 0;
  const eligible = secondaryInwardCalendarReady(si.toObject ? si.toObject() : si, batchLean, today);
  return { avail0, avail1, synced0, synced1, excess, mortDec, eligible, histQty, drift };
}

// ------------------------------------------------------------------------------------------------
// executors (each returns a printable summary; only writes when APPLY)
// ------------------------------------------------------------------------------------------------
async function doReduce(op, ctx) {
  const { session } = ctx;
  const po = await PlantOutward.findOne({ "secondaryInward._id": op.line.inwardId }).session(session || null);
  if (!po) throw new Error(`Line ${op.line.inwardId} not found`);
  const si = po.secondaryInward.id(op.line.inwardId);
  const batchLean = await DispatchBatch.findById(po.batchId).lean().session(session || null);
  const n = planReduceNumbers(si, batchLean, op.amount);

  let slotInfo = "no slot";
  const slotId = si.linkedBookingSlotId;
  const slotLoaded = n.excess > 0 && slotId ? await loadSlot(slotId, session) : null;
  if (slotLoaded) {
    const { slot } = slotLoaded;
    const pa = Number(slot.actualPlants) || 0;
    const pm = Number(slot.expectedMortality) || 0;
    const pr = Number(slot.actualReadyPlants) || 0;
    const readyDec = n.eligible ? Math.min(n.excess, pr) : 0;
    slotInfo = `slot actual ${fmt(pa)}→${fmt(Math.max(0, pa - n.excess))}, mort ${fmt(pm)}→${fmt(Math.max(0, pm - n.mortDec))}, ready ${fmt(pr)}→${fmt(pr - readyDec)}${n.eligible && pr < n.excess ? "  !! slot ready lower than synced" : ""}`;
  } else if (n.excess > 0) slotInfo = "synced stock but slot not found !!";

  if (APPLY) {
    const now = new Date();
    await PlantOutward.updateOne(
      { _id: po._id, "secondaryInward._id": op.line.inwardId },
      {
        $set: {
          "secondaryInward.$.availableQuantity": n.avail1,
          "secondaryInward.$.transferStatus": n.avail1 === 0 ? "fully_transferred" : "partially_transferred",
          "secondaryInward.$.slotStockSyncedPlants": n.synced1,
        },
        $push: {
          "secondaryInward.$.transferHistory": {
            transferDate: now,
            quantityTransferred: n.histQty,
            remarks: `${REASON}${n.histQty !== op.amount ? ` (−${op.amount} now + ${n.histQty - op.amount} earlier unrecorded)` : ""}`,
          },
          "secondaryInward.$.activityLog": {
            action: "STOCK_CORRECTION",
            activityName: `Stock correction · −${op.amount} रोप (notebook count ${AS_ON})`,
            performedAt: now,
            quantity: op.amount,
            previousValue: { availableQuantity: n.avail0, slotStockSyncedPlants: n.synced0 },
            newValue: { availableQuantity: n.avail1, slotStockSyncedPlants: n.synced1, source: SOURCE },
            reason: REASON,
          },
        },
      },
      { session }
    );

    if (slotLoaded && n.excess > 0) {
      const { plantSlot, slot } = slotLoaded;
      const pa = Number(slot.actualPlants) || 0;
      const pm = Number(slot.expectedMortality) || 0;
      const pr = Number(slot.actualReadyPlants) || 0;
      const updates = {
        actualPlants: Math.max(0, pa - n.excess),
        expectedMortality: Math.max(0, pm - n.mortDec),
      };
      if (n.eligible) updates.actualReadyPlants = Math.max(0, pr - Math.min(n.excess, pr));
      applyStockFieldUpdates(slot, updates, null, `Stock correction · batch ${batchLean?.batchNumber} (−${n.excess} actual)`);
      await plantSlot.save({ session, validateBeforeSave: true });
    }

    const led = await SecondaryDispatchAvailability.findOne({ dispatchBatchId: po.batchId }).session(session);
    const fl = led?.fifoLines?.find((l) => String(l.secondaryInwardId) === String(op.line.inwardId));
    if (led && fl) {
      const prev = led.totalAvailablePlants;
      fl.remainingPlants = Math.max(0, Math.min(fl.remainingPlants, n.avail1));
      led.recalcTotal();
      led.availabilityTrail.unshift({
        action: "ADJUST",
        activityName: "Stock correction (notebook count)",
        quantity: op.amount,
        previousTotalAvailable: prev,
        newTotalAvailable: led.totalAvailablePlants,
        reason: REASON,
        plantOutwardId: po._id,
        secondaryInwardId: op.line.inwardId,
      });
      await led.save({ session });
    }
  }
  return `reduce  ${op.line.shed.split(" (")[0].padEnd(10)} ${op.line.batch.padEnd(22)} ${op.line.lagwad ? short(op.line.lagwad) : "  - "}  −${fmt(op.amount).padStart(7)}  (${fmt(n.avail0)}→${fmt(n.avail1)})${n.drift ? ` [history drift ${fmt(n.drift)}]` : ""}  ${slotInfo}`;
}

async function doMove(op, ctx) {
  const { session } = ctx;
  const po = await PlantOutward.findOne({ "secondaryInward._id": op.line.inwardId }).session(session || null);
  const si = po.secondaryInward.id(op.line.inwardId);
  const from = si.pollyhouse;
  if (APPLY) {
    const lineId = si._id;
    await PlantOutward.updateOne(
      { _id: po._id },
      {
        $set: { "secondaryInward.$[si].pollyhouse": op.toShed, "secondaryOutward.$[so].pollyhouse": op.toShed },
        $push: {
          "secondaryInward.$[si].activityLog": {
            action: "SHED_CHANGED",
            activityName: `Shed corrected · ${from} → ${op.toShed}`,
            performedAt: new Date(),
            quantity: Number(si.availableQuantity) || 0,
            previousValue: { pollyhouse: from },
            newValue: { pollyhouse: op.toShed, source: SOURCE },
            reason: `Notebook ${AS_ON}: stock is physically in ${op.toShed}`,
          },
        },
      },
      { session, arrayFilters: [{ "si._id": lineId }, { "so.sourceSecondaryInwardId": lineId }] }
    );
  }
  return `move    ${op.line.batch.padEnd(22)} ${short(op.line.lagwad)}  ${fmt(op.line.remaining).padStart(7)}  ${from} → ${op.toShed}`;
}

const templates = {};
async function templateFor(kind) {
  if (templates[kind]) return templates[kind];
  const g9 = await DispatchBatch.findOne({ batchNumber: G9_TEMPLATE_BATCH }).lean();
  if (!g9) throw new Error(`Template batch ${G9_TEMPLATE_BATCH} missing`);
  const days = Number(g9.secondaryPlantReadyDays) || 30;
  templates[kind] =
    kind === "Vasai"
      ? { plantCmsId: BANANA_PLANT_ID, plantSubtypeId: SUBTYPE_VASAI, primaryPlantReadyDays: g9.primaryPlantReadyDays, secondaryPlantReadyDays: days }
      : { plantCmsId: g9.plantCmsId ?? BANANA_PLANT_ID, plantSubtypeId: g9.plantSubtypeId ?? SUBTYPE_G9, primaryPlantReadyDays: g9.primaryPlantReadyDays, secondaryPlantReadyDays: days };
  return templates[kind];
}

async function resolveBatch(name, ctx) {
  const { session, masters } = ctx;
  let hit = masters.find((m) => m.batchNumber === name);
  // dry run only: the batch migration has not run yet, so use the master that will become <name>
  if (!hit && !APPLY) {
    hit = masters.find((m) => canonicalName(m.batchNumber) === name);
    if (hit) return { batch: hit, created: false, willBeRenamedFrom: hit.batchNumber };
  }
  if (hit) return { batch: hit, created: false };

  const base = await templateFor(isVasai(name) ? "Vasai" : "G9");
  if (!APPLY) {
    const fake = { _id: `new:${name}`, batchNumber: name, ...base };
    masters.push(fake);
    return { batch: fake, created: true };
  }
  const [doc] = await DispatchBatch.create([{ batchNumber: name, dateAdded: new Date(), ...base, isActive: true }], { session });
  const batch = doc.toObject();
  await PlantOutward.create([{ batchId: batch._id, dateAdded: batch.dateAdded }], { session });
  masters.push(batch);
  return { batch, created: true };
}

async function doAdd(op, ctx) {
  const { session } = ctx;
  const { batch, created, willBeRenamedFrom } = await resolveBatch(op.batch, ctx);
  const days = Number(batch.secondaryPlantReadyDays) || 30;
  const lagwad = op.lagwad || shiftDay(AS_ON, -days);
  const inwardDate = moment(lagwad).startOf("day").toDate();
  const ready = expectedReadyDateForSecondarySize(inwardDate, SIZE, batch);
  const split = splitLagwadQtyForSlot(op.plants);
  const slotId = await resolveBookingSlotIdForSecondaryBatch(batch, ready);
  const eligible = secondaryInwardCalendarReady({ secondaryInwardDate: inwardDate, expectedReadyDate: ready, size: SIZE }, batch, today);
  const trays = Math.max(1, Math.ceil(op.plants / CAVITY));
  const summary = `add     ${op.shed.split(" (")[0].padEnd(10)} ${op.batch.padEnd(10)} lagwad ${short(lagwad)} ready ${short(moment(ready).format("YYYY-MM-DD"))}  +${fmt(op.plants).padStart(7)}  ${created ? "NEW BATCH " : ""}${willBeRenamedFrom ? `(= ${willBeRenamedFrom}) ` : ""}slot ${slotId ? "ok" : "NONE !!"} (actual ${fmt(split.actualPlants)}, mort ${fmt(split.expectedMortality)}${eligible ? ", ready" : ""})`;
  if (!APPLY) return summary;

  let po = await PlantOutward.findOne({ batchId: batch._id }).session(session);
  if (!po) [po] = await PlantOutward.create([{ batchId: batch._id, dateAdded: new Date() }], { session });
  // cast through the schema (defaults + _id) but insert with $push so other lines of the batch are NOT recomputed
  const pushed = po.secondaryInward.create({
    secondaryInwardDate: inwardDate,
    numberOfBottles: trays,
    size: SIZE,
    cavity: CAVITY,
    numberOfTrays: trays,
    totalQuantity: op.plants,
    availableQuantity: op.plants,
    pollyhouse: op.shed,
    laboursEngaged: 1,
    transferStatus: "available",
    dateOfDispatch: ready,
    expectedReadyDate: ready,
  });
  await PlantOutward.updateOne({ _id: po._id }, { $push: { secondaryInward: pushed.toObject() } }, { session });

  await recordSecondaryInwardOnLedger(session, {
    dispatchBatchId: batch._id,
    plantOutwardId: po._id,
    secondaryInwardId: pushed._id,
    secondaryInwardDate: inwardDate,
    plants: op.plants,
    size: SIZE,
  });
  if (slotId) {
    await PlantOutward.updateOne(
      { batchId: batch._id, "secondaryInward._id": pushed._id },
      { $set: { "secondaryInward.$.linkedBookingSlotId": slotId } },
      { session }
    );
  }
  await recordShedActivity({
    batchId: batch._id,
    stage: "secondary_inward",
    subdocId: pushed._id,
    action: SHED_ACTIVITY_ACTIONS.SECONDARY_LAGWAD_RECORDED,
    activityName: `Notebook stock ${AS_ON} · ${op.plants} रोप · ${SIZE}`,
    quantity: op.plants,
    newValue: { size: SIZE, expectedReadyDate: ready, pollyhouse: op.shed, source: SOURCE },
    reason: REASON,
    session,
  });
  const siPlain = pushed.toObject();
  siPlain.linkedBookingSlotId = slotId || siPlain.linkedBookingSlotId;
  const sync = await syncSecondaryInwardSlotStockAdd({
    session,
    batchId: batch._id,
    secondaryInwardId: pushed._id,
    batchLean: batch,
    siPlain,
    dispatchEligible: eligible,
    force: true,
  });
  await refreshSecondarySummary(PlantOutward, po._id, session);
  return `${summary}  → synced ${sync?.applied ?? 0}`;
}

// ------------------------------------------------------------------------------------------------
// projection: what the system will look like after the ops (pure, no DB)
// ------------------------------------------------------------------------------------------------
function projectAfter(ops, rows, sysLines, shedTotals) {
  const entries = new Map(); // key -> entry
  for (const l of sysLines)
    entries.set(l.inwardId, { shed: l.shed, batch: l.canon || l.batch, lagwad: l.lagwad, before: l.remaining, after: l.remaining, note: "" });
  const added = [];
  for (const op of ops) {
    if (op.type === "reduce") {
      const e = entries.get(op.line.inwardId);
      e.after -= op.amount;
      e.note = e.after === 0 ? "zeroed" : "reduced";
    } else if (op.type === "move") {
      const e = entries.get(op.line.inwardId);
      e.fromShed = e.shed;
      e.shed = op.toShed;
      e.note = `moved from ${e.fromShed.split(" (")[0]}`;
    } else if (op.type === "add") {
      const batch = op.batch;
      const days = 30;
      const lagwad = op.lagwad || shiftDay(AS_ON, -days);
      const e = { shed: op.shed, batch, lagwad, before: 0, after: op.plants, note: op.lagwad ? "NEW lagwad entry (date from paper)" : `NEW entry, ready ${short(AS_ON)}`, row: op.row };
      added.push(e);
      entries.set(`new:${added.length}`, e);
    }
  }
  const all = [...entries.values()];
  // per paper row verification
  const checks = rows
    .filter((r) => r.op.kind !== "skip-shed")
    .map((r) => {
      const lineSum = (r.op.lines || []).reduce((s, l) => s + (entries.get(l.inwardId)?.after ?? 0), 0);
      const addSum = added.filter((a) => a.row === r).reduce((s, a) => s + a.after, 0);
      const after = lineSum + addSum;
      return { shed: r.shed, item: r.item, paper: r.paper, before: r.system, after, ok: after === r.paper };
    });
  const shedAfter = shedTotals.map((t) => {
    const name = t.sysShed || t.shed;
    const sum = all.filter((e) => e.shed === name).reduce((s, e) => s + e.after, 0);
    return { ...t, after: sum };
  });
  return { all, checks, shedAfter };
}

function printProjection({ all, checks, shedAfter }) {
  console.log("\n================ AFTER-UPDATE PROJECTION (every entry) ================");
  const sheds = [...new Set(all.map((e) => e.shed))];
  for (const s of sheds) {
    const es = all.filter((e) => e.shed === s && (e.before > 0 || e.after > 0));
    if (!es.length) continue;
    const b = es.reduce((x, e) => x + e.before, 0);
    const a = es.reduce((x, e) => x + e.after, 0);
    console.log(`\n## ${s}   before ${fmt(b)}  →  after ${fmt(a)}`);
    const byBatch = new Map();
    for (const e of es) byBatch.set(e.batch, [...(byBatch.get(e.batch) || []), e]);
    for (const [batch, list] of [...byBatch.entries()].sort()) {
      for (const e of list.sort((x, y) => String(x.lagwad).localeCompare(String(y.lagwad)))) {
        const changed = e.before !== e.after || e.note;
        console.log(`   ${batch.padEnd(28)} lagwad ${short(e.lagwad).padEnd(6)} ${fmt(e.before).padStart(9)} → ${fmt(e.after).padStart(9)}  ${changed ? (e.after - e.before >= 0 ? "+" : "") + fmt(e.after - e.before) : "same"}  ${e.note}`);
      }
    }
  }
  console.log("\n================ PAPER vs SYSTEM-AFTER (each paper line) ================");
  for (const c of checks) console.log(`${c.ok ? "MATCH   " : "MISMATCH"} ${c.shed.split(" (")[0].padEnd(10)} ${c.item.slice(0, 55).padEnd(55)} paper ${fmt(c.paper).padStart(8)}  system after ${fmt(c.after).padStart(8)}  (was ${fmt(c.before)})`);
  const okN = checks.filter((c) => c.ok).length;
  console.log(`\nlines matching paper after update: ${okN} / ${checks.length}`);
  console.log("\n================ SHED TOTALS: paper vs system after ================");
  console.log("shed".padEnd(34), "system now".padStart(11), "system after".padStart(13), "paper lines".padStart(12), "paper page total".padStart(17), "after−paper".padStart(12));
  for (const t of shedAfter)
    console.log(t.shed.padEnd(34), fmt(t.system).padStart(11), fmt(t.after).padStart(13), fmt(t.paperLinesSum).padStart(12), fmt(t.writtenTotal).padStart(17), fmt(t.after - t.paperLinesSum).padStart(12), t.shed.includes("NOT ON PAPER") ? "  (left alone)" : "");
  const sum = (k) => shedAfter.reduce((s, t) => s + (t[k] || 0), 0);
  console.log("ALL SHEDS".padEnd(34), fmt(sum("system")).padStart(11), fmt(sum("after")).padStart(13), fmt(sum("paperLinesSum")).padStart(12), fmt(sum("writtenTotal")).padStart(17));
}

// ------------------------------------------------------------------------------------------------
async function main() {
  console.log(APPLY ? "=== APPLY on PROD ===" : "=== DRY RUN (no writes) ===", `as on ${AS_ON}`, ONLY.length ? `only: ${ONLY.join(",")}` : "all sheds");
  await mongoose.connect(url, { serverSelectionTimeoutMS: 15000, ...(APPLY ? {} : { readPreference: "secondaryPreferred" }) });
  console.log("db:", mongoose.connection.name);

  const payload = await loadShedStockPayload();
  const { rows, sysLines, shedTotals } = reconcile(payload, PAPER, AS_ON);
  const ops = buildOps(rows, sysLines);

  const masters = await DispatchBatch.find({}).lean();
  const notRenamed = masters.filter((m) => canonicalName(m.batchNumber) && canonicalName(m.batchNumber) !== m.batchNumber);
  if (APPLY && notRenamed.length) {
    throw new Error(`Batch rename / merge has not been run yet (${notRenamed.length} masters still on old names, e.g. ${notRenamed[0].batchNumber}). Run it first.`);
  }
  if (!APPLY && notRenamed.length) console.log(`(dry run: ${notRenamed.length} batch masters are still on old names; this projection assumes the rename / merge has been done)\n`);
  const ctxBase = { masters };

  const plusTotal = ops.filter((o) => o.type === "add").reduce((s, o) => s + o.plants, 0);
  const minusTotal = ops.filter((o) => o.type === "reduce").reduce((s, o) => s + o.amount, 0);

  const touchedBatchIds = new Set();
  for (const o of ops) if (o.line) touchedBatchIds.add(o.line.batchId);

  let session = null;
  if (APPLY) {
    // backup first
    const batchIds = [...touchedBatchIds, ...masters.filter((m) => ops.some((o) => o.type === "add" && o.batch === m.batchNumber)).map((m) => String(m._id))];
    const pos = await PlantOutward.find({ batchId: { $in: batchIds } }).lean();
    const leds = await SecondaryDispatchAvailability.find({ dispatchBatchId: { $in: batchIds } }).lean();
    const slotIds = [...new Set(pos.flatMap((p) => (p.secondaryInward || []).map((s) => String(s.linkedBookingSlotId || ""))).filter(Boolean))];
    const slots = await PlantSlot.find({ "subtypeSlots.slots._id": { $in: slotIds } }).lean();
    const dir = path.resolve("..", "dryrun-reports");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `backup-before-apply-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify({ plantOutwards: pos, ledgers: leds, plantSlots: slots }));
    console.log("backup written:", file, `(${pos.length} plantOutward, ${leds.length} ledgers, ${slots.length} slot docs)`);
    session = await mongoose.startSession();
    session.startTransaction({ maxCommitTimeMS: 120000 });
  }

  const ctx = { ...ctxBase, session };
  const lines = [];
  try {
    for (const op of ops) {
      const text = op.type === "reduce" ? await doReduce(op, ctx) : op.type === "move" ? await doMove(op, ctx) : await doAdd(op, ctx);
      lines.push(text);
      console.log(text);
    }
    if (session) await session.commitTransaction();
  } catch (err) {
    if (session) await session.abortTransaction();
    console.error("\nFAILED – nothing was written:", err);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  } finally {
    if (session) session.endSession();
  }

  console.log(`\nops: ${ops.length}   +${fmt(plusTotal)}   −${fmt(minusTotal)}   net ${fmt(plusTotal - minusTotal)}`);

  if (APPLY) {
    const after = await loadShedStockPayload();
    const { rows: rows2, shedTotals: totals2 } = reconcile(after, PAPER, AS_ON);
    console.log("\n--- AFTER APPLY: shed totals (paper lines sum vs system) ---");
    for (const t of totals2) console.log(t.shed.padEnd(34), fmt(t.paperLinesSum).padStart(10), fmt(t.system).padStart(10), fmt(t.paperLinesSum - t.system).padStart(8));
    const bad = rows2.filter((r) => r.status !== "OK");
    console.log(`\nlines not OK after apply: ${bad.length}`);
    bad.forEach((r) => console.log(" ", r.shed, r.item, "paper", fmt(r.paper), "system", fmt(r.system)));
  } else {
    printProjection(projectAfter(ops, rows, sysLines, shedTotals));
    console.log("\nRe-run with  CONFIRM_PROD=YES ... --apply  to write PROD.");
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
