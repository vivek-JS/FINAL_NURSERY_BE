/**
 * Cron: move open-pipeline orders off expired booking slots to the next slot window.
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
import { runPastDueSlotRollover } from "../services/pastDueSlotRollover.service.js";
import { isSlotEndNightlyMasterEnabled } from "./slotEndNightlyCron.js";

export function initPastDueSlotRolloverCronJobs() {
  if (isSlotEndNightlyMasterEnabled()) {
    console.log(
      "[PastDueRollover] legacy cron skipped (SLOT_END_NIGHTLY_ENABLED=true — use unified SlotEndNightly job)."
    );
    return;
  }

  const enabledFlag = String(process.env.PAST_DUE_SLOT_ROLLOVER_ENABLED || "").trim();
  if (enabledFlag !== "true") {
    console.log(
      `[PastDueRollover] cron off (PAST_DUE_SLOT_ROLLOVER_ENABLED=${enabledFlag || "unset"}). Set true in .env to enable.`
    );
    return;
  }

  const cronExpr = process.env.PAST_DUE_SLOT_ROLLOVER_CRON || "0 1 * * *";
  const tz = process.env.PAST_DUE_SLOT_ROLLOVER_TZ || "Asia/Kolkata";

  cron.schedule(
    cronExpr,
    async () => {
      try {
        console.log("[PastDueRollover] cron started");
        const summary = await runPastDueSlotRollover();
        console.log("[PastDueRollover] cron finished:", summary);
      } catch (err) {
        console.error("[PastDueRollover] cron error:", err?.message || err);
      }
    },
    { scheduled: true, timezone: tz }
  );

  console.log(`✅ [PastDueRollover] cron @ ${cronExpr} (${tz}).`);
}
