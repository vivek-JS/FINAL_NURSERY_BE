/**
 * Undo actualPlants (sow) moved by expired lagwad roll — restore sow on expired window.
 *
 *   node scripts/revert-lagwad-sow-roll.mjs
 *   node scripts/revert-lagwad-sow-roll.mjs --apply
 *   node scripts/revert-lagwad-sow-roll.mjs --apply --hours 72 --plantId <id>
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import SlotTransferLog from "../models/slotTransfer.model.js";
import { revertActualPlantsRoll } from "../services/rollExpiredSlotAvailable.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
const plantArg = process.argv.find((a) => a.startsWith("--plantId="));
const HOURS = hoursArg ? Number(hoursArg.split("=")[1]) : 168;
const PLANT_FILTER = plantArg ? plantArg.split("=")[1] : null;

function mongoUri() {
  return process.env.PROD_MONGO_URL || process.env.MONGO_URL || process.env.MONGODB_URI;
}

async function main() {
  const uri = mongoUri();
  if (!uri) throw new Error("Set PROD_MONGO_URL or MONGO_URL in .env");
  await mongoose.connect(uri);

  const since = new Date(Date.now() - HOURS * 3600 * 1000);
  const match = {
    transferType: "expired_available_roll",
    createdAt: { $gte: since },
    "metadata.actualQty": { $gt: 0 },
  };
  if (PLANT_FILTER) match.plantId = new mongoose.Types.ObjectId(PLANT_FILTER);

  const logs = await SlotTransferLog.find(match).sort({ createdAt: -1 }).lean();
  console.log(
    APPLY ? "=== APPLY revert sow (actualPlants) rolls ===" : "=== DRY RUN ===",
    `found ${logs.length} log(s) since ${since.toISOString()}`
  );

  let reverted = 0;
  for (const log of logs) {
    const act = Math.floor(Number(log.metadata?.actualQty) || 0);
    if (act < 1) continue;
    const fromSlotId = String(log.targetSlotId);
    const toSlotId = String(log.sourceSlotId);
    const line = `[${log.createdAt?.toISOString?.() || "?"}] ${act} sow: ${fromSlotId} → back to expired ${toSlotId} (${log.metadata?.sourceSlotStartDay}-${log.metadata?.sourceSlotEndDay})`;
    if (!APPLY) {
      console.log("would revert", line);
      reverted += 1;
      continue;
    }
    try {
      await revertActualPlantsRoll({
        fromSlotId,
        toSlotId,
        actualQty: act,
        reason: "Revert mistaken sow roll — sow stays on original slot",
      });
      console.log("reverted", line);
      reverted += 1;
    } catch (e) {
      console.error("FAILED", line, e?.message || e);
    }
  }

  console.log(`Done. ${reverted} revert(s) ${APPLY ? "applied" : "would apply"}.`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
