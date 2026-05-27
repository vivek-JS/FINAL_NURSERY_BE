import cron from "node-cron";
import { runShadowReconciliation } from "../modules/finance/reconciliation/shadowReconcile.js";
import { seedChartOfAccounts } from "../modules/finance/coa/seedChartOfAccounts.js";

/**
 * Daily shadow reconciliation (02:30 IST ≈ 21:00 UTC previous day; adjust as needed).
 * Also ensures COA exists on startup.
 */
export async function initFinanceCronJobs() {
  try {
    await seedChartOfAccounts();
    console.log("[Finance] Chart of accounts seed checked");
  } catch (e) {
    console.error("[Finance] COA seed failed:", e?.message || e);
  }

  if (process.env.FINANCE_SHADOW_RECONCILE_CRON === "false") {
    return;
  }

  cron.schedule(
    process.env.FINANCE_SHADOW_RECONCILE_CRON || "30 2 * * *",
    async () => {
      try {
        const result = await runShadowReconciliation({ sampleLimit: 500 });
        console.log(
          `[Finance] Shadow reconcile: ${result.status} checked=${result.totalChecked} mismatches=${result.mismatchCount}`
        );
      } catch (e) {
        console.error("[Finance] Shadow reconcile cron failed:", e?.message || e);
      }
    },
    { timezone: process.env.FINANCE_CRON_TZ || "Asia/Kolkata" }
  );

  console.log("[Finance] Cron jobs initialized");
}
