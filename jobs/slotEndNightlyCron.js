/**
 * Unified nightly slot-end automation (orders → capacity roll → lagwad relocate).
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
import { runSlotEndNightlyAutomation } from "../services/slotEndNightlyAutomation.service.js";

export function isSlotEndNightlyMasterEnabled() {
  return String(process.env.SLOT_END_NIGHTLY_ENABLED || "").trim() === "true";
}

export function initSlotEndNightlyCronJobs() {
  if (!isSlotEndNightlyMasterEnabled()) {
    console.log(
      "[SlotEndNightly] cron off (set SLOT_END_NIGHTLY_ENABLED=true to enable unified slot-end job)."
    );
    return;
  }

  const cronExpr = process.env.SLOT_END_NIGHTLY_CRON || "5 1 * * *";
  const tz = process.env.SLOT_END_NIGHTLY_TZ || "Asia/Kolkata";

  cron.schedule(
    cronExpr,
    async () => {
      try {
        console.log("[SlotEndNightly] cron started");
        const summary = await runSlotEndNightlyAutomation();
        console.log("[SlotEndNightly] cron finished:", JSON.stringify(summary));
      } catch (err) {
        console.error("[SlotEndNightly] cron error:", err?.message || err);
      }
    },
    { scheduled: true, timezone: tz }
  );

  console.log(`✅ [SlotEndNightly] unified cron @ ${cronExpr} (${tz}).`);
}
