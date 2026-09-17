import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("slotEndNightlyAutomation", () => {
  const envSnapshot = {
    SLOT_END_NIGHTLY_ORDERS: process.env.SLOT_END_NIGHTLY_ORDERS,
    SLOT_END_NIGHTLY_CAPACITY_ROLL: process.env.SLOT_END_NIGHTLY_CAPACITY_ROLL,
    SLOT_END_NIGHTLY_LAGWAD_RELOCATE: process.env.SLOT_END_NIGHTLY_LAGWAD_RELOCATE,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("resolveSlotEndNightlySteps defaults sub-steps to true", async () => {
    delete process.env.SLOT_END_NIGHTLY_ORDERS;
    delete process.env.SLOT_END_NIGHTLY_CAPACITY_ROLL;
    delete process.env.SLOT_END_NIGHTLY_LAGWAD_RELOCATE;
    const { resolveSlotEndNightlySteps } = await import(
      "../services/slotEndNightlyAutomation.service.js"
    );
    const steps = resolveSlotEndNightlySteps();
    assert.equal(steps.orders, true);
    assert.equal(steps.capacityRoll, true);
    assert.equal(steps.lagwadRelocate, true);
  });

  it("resolveSlotEndNightlySteps respects env false", async () => {
    process.env.SLOT_END_NIGHTLY_CAPACITY_ROLL = "false";
    const { resolveSlotEndNightlySteps } = await import(
      "../services/slotEndNightlyAutomation.service.js"
    );
    assert.equal(resolveSlotEndNightlySteps().capacityRoll, false);
  });

  it("runs enabled steps in order and continues after a step failure", async () => {
    const calls = [];
    const { runSlotEndNightlyAutomation } = await import(
      "../services/slotEndNightlyAutomation.service.js"
    );

    const summary = await runSlotEndNightlyAutomation({
      asOfDate: new Date("2026-06-10T12:00:00+05:30"),
      dryRun: false,
      steps: { orders: true, capacityRoll: true, lagwadRelocate: true },
      runners: {
        runPastDueSlotRollover: async () => {
          calls.push("orders");
          throw new Error("orders boom");
        },
        runExpiredReadyRollAuto: async () => {
          calls.push("capacity");
          return { slotsRolled: 1 };
        },
        runCalendarReadySlotRelocate: async () => {
          calls.push("lagwad");
          return { relocated: 2 };
        },
      },
    });

    assert.deepEqual(calls, ["orders", "capacity", "lagwad"]);
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.errors[0].step, "pastDueOrders");
    assert.equal(summary.expiredCapacityRoll.slotsRolled, 1);
    assert.equal(summary.calendarReadyRelocate.relocated, 2);
  });

  it("dry-run skips capacity and lagwad writes", async () => {
    const calls = [];
    const { runSlotEndNightlyAutomation } = await import(
      "../services/slotEndNightlyAutomation.service.js"
    );

    const summary = await runSlotEndNightlyAutomation({
      dryRun: true,
      steps: { orders: true, capacityRoll: true, lagwadRelocate: true },
      runners: {
        runPastDueSlotRollover: async ({ dryRun }) => {
          calls.push(`orders:${dryRun}`);
          return { dryRun, ordersMoved: 0 };
        },
        runExpiredReadyRollAuto: async () => {
          calls.push("capacity");
          return {};
        },
        runCalendarReadySlotRelocate: async () => {
          calls.push("lagwad");
          return {};
        },
      },
    });

    assert.deepEqual(calls, ["orders:true"]);
    assert.equal(summary.expiredCapacityRoll.skipped, true);
    assert.equal(summary.calendarReadyRelocate.skipped, true);
  });
});

describe("slotEndNightlyCron", () => {
  it("isSlotEndNightlyMasterEnabled reads env", async () => {
    const prev = process.env.SLOT_END_NIGHTLY_ENABLED;
    process.env.SLOT_END_NIGHTLY_ENABLED = "true";
    const { isSlotEndNightlyMasterEnabled } = await import(
      "../jobs/slotEndNightlyCron.js"
    );
    assert.equal(isSlotEndNightlyMasterEnabled(), true);
    process.env.SLOT_END_NIGHTLY_ENABLED = "false";
    assert.equal(isSlotEndNightlyMasterEnabled(), false);
    if (prev === undefined) delete process.env.SLOT_END_NIGHTLY_ENABLED;
    else process.env.SLOT_END_NIGHTLY_ENABLED = prev;
  });
});
