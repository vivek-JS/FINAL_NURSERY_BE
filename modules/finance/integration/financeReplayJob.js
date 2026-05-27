import { seedChartOfAccounts } from "../coa/seedChartOfAccounts.js";
import { setFinanceSerialPost } from "../posting/financePostLock.js";
import { replayAllSubLedgersToCentral } from "./replaySubLedgerToCentral.js";

/** In-process replay job state (single runner at a time). */
let replayJob = {
  running: false,
  startedAt: null,
  finishedAt: null,
  startedBy: null,
  options: null,
  stats: null,
  error: null,
};

export function getReplayJobStatus() {
  return { ...replayJob };
}

/**
 * Start sub-ledger → central replay in the background.
 * @returns {{ started: boolean, alreadyRunning?: boolean, job: object }}
 */
export async function startSubLedgerReplayJob(options = {}, startedBy) {
  if (replayJob.running) {
    return { started: false, alreadyRunning: true, job: getReplayJobStatus() };
  }

  replayJob = {
    running: true,
    startedAt: new Date(),
    finishedAt: null,
    startedBy: startedBy ? String(startedBy) : null,
    options,
    stats: null,
    error: null,
  };

  setImmediate(async () => {
    setFinanceSerialPost(true);
    try {
      await seedChartOfAccounts();
      const stats = await replayAllSubLedgersToCentral({
        sources: options.sources,
        dryRun: false,
        since: options.since,
        until: options.until,
      });
      replayJob.stats = stats;
    } catch (err) {
      replayJob.error = String(err?.message || err);
      console.error("[Finance] sub-ledger replay failed:", replayJob.error);
    } finally {
      setFinanceSerialPost(false);
      replayJob.running = false;
      replayJob.finishedAt = new Date();
    }
  });

  return { started: true, job: getReplayJobStatus() };
}
