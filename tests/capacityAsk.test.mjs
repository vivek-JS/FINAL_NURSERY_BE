import test from "node:test";
import assert from "node:assert/strict";
import {
  bookingDirection,
  commodityMatchesCrops,
  contextBrief,
  cropsOnSheet,
  groundAdvice,
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

test("rules analyst splits plants and subtypes from our sheet", () => {
  const advice = rulesAnalyst({
    district: "",
    capacity: {
      totals: { canBook: -1000, gap: 5000 },
      plants: [
        {
          plant: "Papaya",
          canBook: -4000,
          gap: 5000,
          booked: 100,
          sowed: 1000,
          subtypes: [{ name: "Red Lady", canBook: -4000, gap: 5000, booked: 100, sowed: 1000 }],
        },
        {
          plant: "Watermelon",
          canBook: 3000,
          gap: 0,
          booked: 10,
          sowed: 4000,
          subtypes: [],
        },
      ],
    },
    weather: { available: true, rainTotalMm: 5, tempMin: 20, tempMax: 33, place: "Maharashtra" },
    mandi: { available: false, prices: [] },
  });
  assert.equal(advice.plants[0].action, "sow_first");
  assert.equal(advice.plants[0].subtypes[0].action, "sow_first");
  assert.equal(advice.plants[1].action, "book");
  assert.match(advice.summary, /Papaya/);
  assert.match(advice.summary, /Watermelon/);
  assert.match(advice.summary, /Maharashtra/);
});

test("ground advice keeps our plant numbers when the model skips them", () => {
  const advice = groundAdvice(
    {
      action: "wait",
      confidence: 40,
      summary: "Wait and see how the season goes.",
      downside: "Unclear",
      weatherNote: "",
      mandiNote: "",
    },
    {
      district: "",
      capacity: {
        plants: [{ plant: "Chili", canBook: -20, gap: 40, booked: 10, sowed: 20, subtypes: [] }],
      },
      weather: { rainTotalMm: 0 },
    }
  );
  assert.equal(advice.plants[0].plant, "Chili");
  assert.equal(advice.plants[0].canBook, -20);
  assert.equal(advice.plants[0].action, "sow_first");
  assert.match(advice.summary, /Chili/);
});

test("booking flow says why when orders rise in dry weather", () => {
  assert.equal(bookingDirection(1200, 800), "up");
  assert.equal(bookingDirection(700, 1000), "down");
  const brief = contextBrief({
    scope: "Maharashtra",
    flow: {
      recentPlants: 12000,
      previousPlants: 8000,
      direction: "up",
      movers: [{ name: "Watermelon" }],
    },
    weather: { available: true, place: "Maharashtra", rainTotalMm: 12, tempMin: 22, tempMax: 34 },
    mandi: { available: true, prices: [{ commodity: "Watermelon", market: "Nashik", modalPrice: 1800 }] },
  });
  assert.match(brief.booking.title, /up/i);
  assert.match(brief.booking.why, /dry|12 mm/i);
  assert.match(brief.mandi.line, /1,800|1800/);
  assert.match(brief.weather.line, /34/);
});
