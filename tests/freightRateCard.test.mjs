import test from "node:test";
import assert from "node:assert/strict";
import FreightRateCard from "../models/freightRateCard.model.js";
import { DEFAULT_FREIGHT_RATE_CARDS } from "../utility/freightRateDefaults.js";

test("default freight rate cards are valid and have unique codes", () => {
  const codes = new Set();
  for (const card of DEFAULT_FREIGHT_RATE_CARDS) {
    const err = new FreightRateCard(card).validateSync();
    assert.equal(err, undefined, `${card.code}: ${err?.message}`);
    assert.ok(!codes.has(card.code), `duplicate code ${card.code}`);
    codes.add(card.code);
  }
  assert.deepEqual([...codes], ["CHOTA_HATHI", "PICK_UP", "EICHER_14FT", "EICHER"]);
});

test("every default card has a 50 paise local market rate", () => {
  for (const card of DEFAULT_FREIGHT_RATE_CARDS) {
    assert.equal(card.localMarketRatePerPlant, 0.5, card.code);
  }
});

test("chota hathi regular banana slabs match the rate sheet", () => {
  const ch = DEFAULT_FREIGHT_RATE_CARDS.find((c) => c.code === "CHOTA_HATHI");
  const banana = ch.loadTypes.find((l) => l.name === "Regular").slabs.filter((s) => s.crop === "Banana");
  assert.deepEqual(
    banana.map((s) => [s.condition, s.value, s.ratePerKm]),
    [
      ["BELOW", 116, 11.75],
      ["ABOVE", 125, 12.75],
    ]
  );
  assert.equal(ch.shortTripMaxKm, 100);
  assert.equal(ch.shortTripRatePerKm, 12.75);
});

test("model rejects an unknown slab condition", () => {
  const err = new FreightRateCard({
    name: "X",
    code: "X",
    loadTypes: [{ name: "Regular", slabs: [{ crop: "Banana", condition: "NEAR", value: 1, ratePerKm: 1 }] }],
  }).validateSync();
  assert.ok(err);
});
