/**
 * Single truth: order.sowingCoverSources → batch.orderCoveredPlants + flags.
 *
 *   node scripts/reconcile-sowing-batch-cover-prod.mjs
 *   node scripts/reconcile-sowing-batch-cover-prod.mjs --apply
 *   node scripts/reconcile-sowing-batch-cover-prod.mjs --apply --req=SR202610050001
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import { reconcileBatchCoverTruth } from "../utility/reconcileSowingCoverTruth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const REQ_ARG = process.argv.find((a) => a.startsWith("--req="));
const ONLY_REQ = REQ_ARG ? REQ_ARG.slice("--req=".length).trim() : "";

async function main() {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!uri) throw new Error("Missing MONGO_URL / PROD_MONGO_URL");
  console.log(
    APPLY
      ? `APPLY cover truth${ONLY_REQ ? ` · ${ONLY_REQ}` : ""} — PROD\n`
      : `DRY-RUN cover truth${ONLY_REQ ? ` · ${ONLY_REQ}` : ""} — PROD\n`
  );

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const pctByPlant = new Map(
    (await PlantCms.find().select("sowingBuffer sowingMortality").lean()).map((p) => [
      String(p._id),
      Math.max(
        0,
        Number(p.sowingMortality) || Number(p.sowingBuffer) || 0
      ),
    ])
  );

  const col = db.collection("plantslots");
  let scanned = 0;
  let changed = 0;
  let orderFixes = 0;
  const samples = [];

  const cursor = col.find({ "subtypeSlots.slots.sowingBatches.0": { $exists: true } });
  for await (const doc of cursor) {
    const pct = pctByPlant.get(String(doc.plantId)) || 0;
    for (let si = 0; si < (doc.subtypeSlots || []).length; si++) {
      for (let li = 0; li < (doc.subtypeSlots[si].slots || []).length; li++) {
        const slot = doc.subtypeSlots[si].slots[li];
        for (let bi = 0; bi < (slot.sowingBatches || []).length; bi++) {
          const batch = slot.sowingBatches[bi];
          if (!batch?.sowingRequestId) continue;
          if (ONLY_REQ && batch.requestNumber !== ONLY_REQ) continue;
          if (intQty(batch.plantsSowed) < 1) continue;
          scanned += 1;

          const { plan, applied } = await reconcileBatchCoverTruth(db, {
            slotDocId: doc._id,
            path: { si, li, bi },
            batch,
            requestId: batch.sowingRequestId,
            requestNumber: batch.requestNumber,
            sowingBufferPct: batch.sowingBufferPct ?? pct,
            apply: APPLY,
            reason: `Cover truth from sowingCoverSources (${batch.requestNumber || ""})`,
          });

          if (!plan?.changed && plan?.drift === 0 && !(plan?.orderFixes || []).length) continue;
          if (!plan?.changed) continue;

          changed += 1;
          orderFixes += (plan.orderFixes || []).length;
          if (samples.length < 60 || ONLY_REQ) {
            samples.push({
              req: batch.requestNumber || String(batch.sowingRequestId),
              stamped: plan.stamped,
              attributed: plan.attributed,
              delta: plan.drift,
              excess: plan.shownExcess,
              moved: plan.mortalityMovedToExcess,
              orderFixes: (plan.orderFixes || []).length,
              applied: Boolean(applied),
            });
          }
        }
      }
    }
  }

  console.table(samples);
  console.log(
    `\nScanned ${scanned} · changed ${changed} · orderFixes ${orderFixes}${APPLY ? " · APPLIED" : " · dry-run"}`
  );
  await mongoose.disconnect();
}

function intQty(v) {
  return Math.max(0, Math.floor(Number(v) || 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
