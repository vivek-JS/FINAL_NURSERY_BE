import cron from "node-cron";
import { getIciciCorporateConfig } from "../config/iciciCorporate.config.js";
import { fetchAndStoreCorporateStatement } from "../services/iciciCorporateStatement.service.js";
import { runEnhancedReconciliation } from "../services/reconciliationEngine.service.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

/**
 * Daily: fetch statement (lookback N days) → run reconciliation engine.
 * Enable with ICICI_BANKING_CRON_ENABLED=true
 */
export function initBankingCronJobs() {
  const cfg = getIciciCorporateConfig();
  if (!cfg.cron.enabled) {
    log().info("Banking cron disabled (ICICI_BANKING_CRON_ENABLED != true)");
    return;
  }

  cron.schedule(
    cfg.cron.schedule,
    async () => {
      try {
        const to = new Date();
        const from = new Date();
        from.setDate(from.getDate() - cfg.cron.lookbackDays);

        log().info("Banking cron: fetching statement", {
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
        });

        await fetchAndStoreCorporateStatement(from, to, null);

        const result = await runEnhancedReconciliation(from, to, { source: "all" });
        log().info("Banking cron: reconciliation complete", {
          runId: result.runId,
          matched: result.matched?.length,
          suspense: result.suspense?.length,
        });
      } catch (e) {
        log().error("Banking cron failed", { error: e.message });
      }
    },
    { timezone: cfg.cron.timezone }
  );

  log().info("Banking cron initialized", { schedule: cfg.cron.schedule });
}
