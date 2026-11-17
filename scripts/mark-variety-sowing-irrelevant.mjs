/**
 * Watermelon variety sowings strictly before a sow date become irrelevant.
 * Dry-run unless --apply is passed.
 *   node scripts/mark-variety-sowing-irrelevant.mjs --variety Simbha --before 2026-10-06
 *   node scripts/mark-variety-sowing-irrelevant.mjs --variety Prachand --before 2026-09-27 --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import {
  batchSaleableStock,
  isWatermelonPlantName,
  setSowBatchIrrelevant,
} from "../services/sowBatchIrrelevant.service.js";
import { dmyToYmd } from "../services/sowBatchStock.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");
const n = (v) => Math.max(0, Math.floor(Number(v) || 0));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

const varietyNeedle = String(arg("--variety") || "").trim().toLowerCase();
const exceptNeedle = String(arg("--except") || "").trim().toLowerCase();
const beforeYmd = String(arg("--before") || "").trim();
const readyBefore = String(arg("--ready-before") || "").trim();
const ymdOk = (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
if ((!varietyNeedle && !readyBefore) || !ymdOk(beforeYmd) || !ymdOk(readyBefore)) {
  throw new Error("Pass --variety <name> --before YYYY-MM-DD, or --ready-before YYYY-MM-DD");
}

function sowYmd(batch) {
  const fromLabel = dmyToYmd(batch?.sowingDate);
  if (fromLabel) return fromLabel;
  const at = batch?.sowedAt ? new Date(batch.sowedAt) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  const ist = new Date(at.getTime() + 330 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function collect(doc, nameById, subtypeNameById) {
  const hits = [];
  const plantName = nameById.get(String(doc.plantId)) || "";
  if (!isWatermelonPlantName(plantName)) return hits;
  for (const st of doc.subtypeSlots || []) {
    const subtypeName =
      st.subtypeName || subtypeNameById.get(String(st.subtypeId)) || "";
    const subtypeKey = subtypeName.toLowerCase();
    if (varietyNeedle && !subtypeKey.includes(varietyNeedle)) continue;
    if (exceptNeedle && subtypeKey.includes(exceptNeedle)) continue;
    for (const slot of st.slots || []) {
      for (const batch of slot.sowingBatches || []) {
        const sowing = sowYmd(batch);
        if (beforeYmd && (!sowing || sowing >= beforeYmd)) continue;
        const ready = dmyToYmd(batch?.plantReadyDate);
        if (readyBefore && (!ready || ready >= readyBefore)) continue;
        hits.push({
          slotId: String(slot._id),
          batchId: String(batch._id),
          plantName,
          subtypeName,
          requestNumber: batch.requestNumber || "",
          sowingDate: batch.sowingDate || sowing,
          plantReadyDate: batch.plantReadyDate || "",
          plantsSowed: n(batch.plantsSowed),
          excessPlants: n(batch.excessPlants),
          saleable: batch.isIrrelevant ? 0 : batchSaleableStock(batch),
          alreadyIrrelevant: Boolean(batch.isIrrelevant),
        });
      }
    }
  }
  return hits;
}

async function main() {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!uri) throw new Error("Missing MONGO_URL / PROD_MONGO_URL");
  await mongoose.connect(uri);

  const plants = await PlantCms.find({ name: { $regex: /water|tarbuj/i } })
    .select("_id name subtypes._id subtypes.name")
    .lean();
  const nameById = new Map(plants.map((p) => [String(p._id), p.name]));
  const subtypeNameById = new Map();
  for (const plant of plants) {
    for (const st of plant.subtypes || []) subtypeNameById.set(String(st._id), st.name);
  }

  const hits = [];
  const cursor = PlantSlot.find({
    plantId: { $in: plants.map((p) => p._id) },
    "subtypeSlots.slots.sowingBatches.0": { $exists: true },
  })
    .select("plantId subtypeSlots.subtypeId subtypeSlots.subtypeName subtypeSlots.slots")
    .cursor();

  for await (const doc of cursor) hits.push(...collect(doc, nameById, subtypeNameById));

  const open = hits.filter((h) => !h.alreadyIrrelevant);
  const sum = (rows, key) => rows.reduce((s, h) => s + h[key], 0);
  console.log(
    JSON.stringify(
      {
        apply: APPLY,
        variety: varietyNeedle || "all",
        except: exceptNeedle || "",
        sowingBefore: beforeYmd || "",
        readyBefore: readyBefore || "",
        totals: {
          batches: hits.length,
          alreadyIrrelevant: hits.length - open.length,
          toMark: open.length,
          plantsSowed: sum(open, "plantsSowed"),
          excessPlants: sum(open, "excessPlants"),
          saleable: sum(open, "saleable"),
        },
        hits: hits.map(({ slotId, batchId, ...rest }) => rest),
      },
      null,
      2
    )
  );

  if (!APPLY) {
    console.log("Dry run only. Re-run with --apply to mark the ones that are not already irrelevant.");
    return;
  }

  let marked = 0;
  const failed = [];
  for (const hit of open) {
    try {
      await setSowBatchIrrelevant({
        slotId: hit.slotId,
        batchId: hit.batchId,
        isIrrelevant: true,
      });
      marked += 1;
    } catch (err) {
      failed.push({ requestNumber: hit.requestNumber, sowingDate: hit.sowingDate, error: err?.message || String(err) });
    }
  }
  console.log(JSON.stringify({ marked, failed }, null, 2));
}

try {
  await main();
} finally {
  await mongoose.disconnect();
}
