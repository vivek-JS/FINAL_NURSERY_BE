/**
 * Nightly slot-end automation: past-due orders → expired capacity roll → calendar-ready lagwad relocate.
 */

import moment from "moment";
import { runPastDueSlotRollover as defaultRunPastDueSlotRollover } from "./pastDueSlotRollover.service.js";
import { runExpiredReadyRollAuto as defaultRunExpiredReadyRollAuto } from "./rollExpiredSlotAvailable.service.js";
import { runCalendarReadySlotRelocate as defaultRunCalendarReadySlotRelocate } from "./calendarReadySlotRelocate.service.js";

const defaultRunners = {
  runPastDueSlotRollover: defaultRunPastDueSlotRollover,
  runExpiredReadyRollAuto: defaultRunExpiredReadyRollAuto,
  runCalendarReadySlotRelocate: defaultRunCalendarReadySlotRelocate,
};

const IST_OFFSET = "+05:30";

function asOfStartOfDayIst(asOfDate) {
  return moment(asOfDate).utcOffset(IST_OFFSET).startOf("day").toDate();
}

function envBool(name, defaultWhenUnset = true) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultWhenUnset;
  return String(raw).trim().toLowerCase() === "true";
}

/** Sub-step flags for cron / manual run (defaults true). */
export function resolveSlotEndNightlySteps(overrides = {}) {
  return {
    orders:
      overrides.orders !== undefined
        ? Boolean(overrides.orders)
        : envBool("SLOT_END_NIGHTLY_ORDERS", true),
    capacityRoll:
      overrides.capacityRoll !== undefined
        ? Boolean(overrides.capacityRoll)
        : envBool("SLOT_END_NIGHTLY_CAPACITY_ROLL", true),
    lagwadRelocate:
      overrides.lagwadRelocate !== undefined
        ? Boolean(overrides.lagwadRelocate)
        : envBool("SLOT_END_NIGHTLY_LAGWAD_RELOCATE", true),
  };
}

/**
 * @param {{
 *   asOfDate?: Date|string,
 *   dryRun?: boolean,
 *   steps?: { orders?: boolean, capacityRoll?: boolean, lagwadRelocate?: boolean },
 *   plantId?: string,
 *   subtypeId?: string,
 *   onProgress?: (msg: string) => void,
 *   runners?: typeof defaultRunners,
 * }} options
 */
export async function runSlotEndNightlyAutomation({
  asOfDate,
  dryRun = false,
  steps: stepOverrides,
  plantId,
  subtypeId,
  onProgress,
  runners = defaultRunners,
} = {}) {
  const log = (msg) => {
    if (onProgress) onProgress(msg);
    else console.log(msg);
  };

  const asOf = asOfStartOfDayIst(asOfDate ? new Date(asOfDate) : new Date());
  const steps = resolveSlotEndNightlySteps(stepOverrides);
  const summary = {
    asOf: moment(asOf).utcOffset(IST_OFFSET).format("YYYY-MM-DD"),
    dryRun: Boolean(dryRun),
    steps,
    pastDueOrders: null,
    expiredCapacityRoll: null,
    calendarReadyRelocate: null,
    errors: [],
  };

  if (steps.orders) {
    try {
      log("[slot-end-nightly] step 1/3: past-due order rollover...");
      summary.pastDueOrders = await runners.runPastDueSlotRollover({
        asOfDate: asOf,
        dryRun,
        plantId,
        subtypeId,
        onProgress,
      });
    } catch (err) {
      const message = err?.message || String(err);
      summary.errors.push({ step: "pastDueOrders", message });
      log(`[slot-end-nightly] past-due orders failed: ${message}`);
    }
  } else {
    log("[slot-end-nightly] step 1/3: past-due orders skipped (disabled)");
  }

  if (steps.capacityRoll) {
    if (dryRun) {
      log(
        "[slot-end-nightly] step 2/3: expired capacity roll skipped (dry-run — orders-only preview)"
      );
      summary.expiredCapacityRoll = {
        skipped: true,
        reason: "dry_run",
      };
    } else {
      try {
        log("[slot-end-nightly] step 2/3: expired capacity + ready roll...");
        summary.expiredCapacityRoll = await runners.runExpiredReadyRollAuto({
          asOfDate: asOf,
        });
      } catch (err) {
        const message = err?.message || String(err);
        summary.errors.push({ step: "expiredCapacityRoll", message });
        log(`[slot-end-nightly] expired capacity roll failed: ${message}`);
      }
    }
  } else {
    log("[slot-end-nightly] step 2/3: expired capacity roll skipped (disabled)");
  }

  if (steps.lagwadRelocate) {
    if (dryRun) {
      log(
        "[slot-end-nightly] step 3/3: calendar-ready lagwad relocate skipped (dry-run)"
      );
      summary.calendarReadyRelocate = {
        skipped: true,
        reason: "dry_run",
      };
    } else {
      try {
        log("[slot-end-nightly] step 3/3: calendar-ready lagwad relocate...");
        summary.calendarReadyRelocate = await runners.runCalendarReadySlotRelocate({
          asOfDate: asOf,
        });
      } catch (err) {
        const message = err?.message || String(err);
        summary.errors.push({ step: "calendarReadyRelocate", message });
        log(`[slot-end-nightly] lagwad relocate failed: ${message}`);
      }
    }
  } else {
    log("[slot-end-nightly] step 3/3: lagwad relocate skipped (disabled)");
  }

  log(
    `[slot-end-nightly] complete dryRun=${dryRun} errors=${summary.errors.length}`
  );
  return summary;
}
