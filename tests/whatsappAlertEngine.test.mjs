/**
 * WhatsApp alert engine — pure rule tests (no DB / WhatsApp).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifySlotRow,
  orderPlantQty,
  getAlertEngineRules,
} from "../services/whatsappAlertEngine.service.js";
import {
  shouldSkipAlert,
  markAlertSent,
  clearAlertDedupeForTests,
} from "../services/whatsappAlertDedupe.service.js";

const rules = {
  bigOrderQty: 10000,
  slotLowUtilPct: 80,
  slotLowAvailAbs: 1000,
  slotHighAvailPct: 60,
  slotHighAvailAbs: 5000,
  slotDigestMaxRows: 12,
};

test("orderPlantQty sums base + additional", () => {
  assert.equal(orderPlantQty({ numberOfPlants: 8000, additionalPlants: 3000 }), 11000);
  assert.equal(orderPlantQty({ totalPlants: 12000, numberOfPlants: 1 }), 12000);
});

test("classifySlotRow — overbooked", () => {
  assert.equal(
    classifySlotRow(
      {
        status: "overbooked",
        totalPlants: 5000,
        bookedPlants: 5200,
        availablePlants: -200,
        slotId: "1",
      },
      rules
    ),
    "overbooked"
  );
});

test("classifySlotRow — full", () => {
  assert.equal(
    classifySlotRow(
      {
        status: "full",
        totalPlants: 5000,
        bookedPlants: 5000,
        availablePlants: 0,
        slotId: "2",
      },
      rules
    ),
    "full"
  );
});

test("classifySlotRow — low utilization", () => {
  assert.equal(
    classifySlotRow(
      {
        status: "ok",
        totalPlants: 10000,
        bookedPlants: 8500,
        availablePlants: 1500,
        slotId: "3",
      },
      rules
    ),
    "low"
  );
});

test("classifySlotRow — high availability", () => {
  assert.equal(
    classifySlotRow(
      {
        status: "ok",
        totalPlants: 20000,
        bookedPlants: 5000,
        availablePlants: 15000,
        slotId: "4",
      },
      rules
    ),
    "high"
  );
});

test("classifySlotRow — normal returns null", () => {
  assert.equal(
    classifySlotRow(
      {
        status: "ok",
        totalPlants: 10000,
        bookedPlants: 5000,
        availablePlants: 5000,
        slotId: "5",
      },
      rules
    ),
    null
  );
});

test("alert dedupe cooldown", () => {
  clearAlertDedupeForTests();
  assert.equal(shouldSkipAlert("test-key"), false);
  markAlertSent("test-key");
  assert.equal(shouldSkipAlert("test-key"), true);
  clearAlertDedupeForTests();
});

test("getAlertEngineRules returns numeric thresholds", () => {
  const r = getAlertEngineRules();
  assert.ok(r.bigOrderQty >= 1);
  assert.ok(r.slotLowUtilPct >= 1);
});
