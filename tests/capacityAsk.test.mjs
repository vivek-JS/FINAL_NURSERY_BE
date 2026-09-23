import test from "node:test";
import assert from "node:assert/strict";
import {
  commodityMatchesCrops,
  cropsOnSheet,
  parseAnalystJson,
  rulesAnalyst,
} from "../utility/capacityAsk.js";

test("parser keeps a valid analyst object and drops junk around it", () => {
  const parsed = parseAnalystJson(
    'note {"action":"sow_first","confidence":82,"summary":"Sow first","downside":"Gap is open","weatherNote":"Dry","mandiNote":"No prices"} thanks'
  );
  assert.equal(parsed.action, "sow_first");
  assert.equal(parsed.confidence, 82);
  assert.equal(parseAnalystJson("not json"), null);
  assert.equal(parseAnalystJson('{"action":"fly","confidence":10}'), null);
});

test("crop match uses the plants on the sheet", () => {
  const crops = cropsOnSheet([{ plantName: "Watermelon" }, { plantName: "Chili hybrid" }]);
  assert.deepEqual(crops, ["watermelon", "chili"]);
  assert.equal(commodityMatchesCrops("Water Melon", crops), true);
  assert.equal(commodityMatchesCrops("Onion", crops), false);
});

test("rules analyst sows first when can book is negative", () => {
  const advice = rulesAnalyst({
    district: "Nashik",
    capacity: { totals: { canBook: -4000, gap: 9000 } },
    weather: { available: true, rainTotalMm: 5, tempMin: 22, tempMax: 34 },
    mandi: { available: false, prices: [] },
  });
  assert.equal(advice.action, "sow_first");
  assert.ok(advice.confidence >= 20 && advice.confidence <= 85);
});
