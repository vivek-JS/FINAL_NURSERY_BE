import cron from "node-cron";
import { getIciciCorporateConfig } from "../config/iciciCorporate.config.js";
import { fetchAndStoreCorporateStatement } from "../services/iciciCorporateStatement.service.js";
import { runEnhancedReconciliation } from "../services/reconciliationEngine.service.js";
import { pollOpenPayouts } from "../services/iciciPayout.service.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

/**
 * Daily: fetch statement (lookback N days) → run reconciliation engine.
 * Enable with ICICI_BANKING_CRON_ENABLED=true
 *
 * Every 15 min: ask ICICI about payouts that are with the bank.
 * Enable with ICICI_PAYOUT_POLL_ENABLED=true
 *
 * Hourly: reconcile the stored statement (no bank call), so a payment or
 * credit unmatched for 24 h goes to suspense. Off with BANKING_SUSPENSE_SWEEP_ENABLED=false
 */
export function initBankingCronJobs() {
  const cfg = getIciciCorporateConfig();

  if (cfg.payout.pollEnabled) {
    let running = false;
    cron.schedule(
      cfg.payout.pollSchedule,
      async () => {
        if (running) return;
        running = true;
        try {
          const result = await pollOpenPayouts();
          if (result.checked || result.recoveredStuck) {
            log().info("Payout poll complete", result);
          }
        } catch (e) {
          log().error("Payout poll failed", { error: e.message });
        } finally {
          running = false;
        }
      },
      { timezone: cfg.cron.timezone }
    );
    log().info("Payout status poller initialized", { schedule: cfg.payout.pollSchedule });
  }

  if (cfg.suspenseSweep.enabled) {
    let sweeping = false;
    cron.schedule(
      cfg.suspenseSweep.schedule,
      async () => {
        if (sweeping) return;
        sweeping = true;
        try {
          const to = new Date();
          const from = new Date(to.getTime() - cfg.suspenseSweep.lookbackDays * 24 * 60 * 60 * 1000);
          const result = await runEnhancedReconciliation(from, to, { source: "all" });
          if (result.updatedCount || result.suspense?.length) {
            log().info("Suspense sweep complete", {
              runId: result.runId,
              matched: result.updatedCount,
              suspense: result.suspense?.length,
              waiting: result.waiting,
            });
          }
        } catch (e) {
          log().error("Suspense sweep failed", { error: e.message });
        } finally {
          sweeping = false;
        }
      },
      { timezone: cfg.cron.timezone }
    );
    log().info("Suspense sweep initialized", { schedule: cfg.suspenseSweep.schedule });
  }

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
