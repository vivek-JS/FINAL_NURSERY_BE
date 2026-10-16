import test from "node:test";
import assert from "node:assert/strict";
import {
  answerFocus,
  boardForAnalyst,
  rowsMentioned,
  bookingDirection,
  commodityMatchesCrops,
  contextBrief,
  cropsOnSheet,
  groundAdvice,
  parseAnalystJson,
  rulesAnalyst,
  rulesAnswer,
} from "../utility/capacityAsk.js";

const BOARD = {
  today: "2026-10-16",
  overdueLookbackDays: 30,
  rows: [
    {
      plantName: "Papaya",
      subtypeName: "Taiwan",
      slotDays: 7,
      sowingAllowed: true,
      stock: { inShed: 8200, readyNow: 5200, batches: [{}, {}] },
      current: {
        startDay: "12-10-2026",
        endDay: "18-10-2026",
        ready: 11100,
        booked: 12300,
        net: -1200,
        overdue: { booked: 5100, unsold: 0 },
      },
      upcoming: [{ startDay: "19-10-2026", endDay: "25-10-2026", ready: 6500, booked: 5000, net: 1500 }],
    },
    {
      plantName: "Watermelon",
      subtypeName: "Impact",
      slotDays: 1,
      sowingAllowed: true,
      stock: { inShed: 0, readyNow: 0, batches: [] },
      current: { startDay: "16-10-2026", endDay: "16-10-2026", ready: 16000, booked: 12000, net: 4000, overdue: {} },
      upcoming: [],
    },
    {
      plantName: "Banana",
      subtypeName: "G9",
      slotDays: 0,
      sowingAllowed: false,
      stock: { inShed: 1729, readyNow: 1500, batches: [{}] },
      current: {},
      upcoming: [],
    },
  ],
};

test("board packet marks urgent varieties and stock-only crops", () => {
  const packet = boardForAnalyst(BOARD);
  const [papaya, melon, banana] = packet.varieties;
  assert.equal(papaya.urgent, true);
  assert.equal(papaya.now.slot, "12-10-2026 to 18-10-2026");
  assert.equal(papaya.now.overdueBooked, 5100);
  assert.equal(papaya.next[0].net, 1500);
  assert.equal(melon.urgent, false);
  assert.equal(melon.now.slot, "16-10-2026");
  assert.equal(banana.sowingRequired, false);
  assert.equal(banana.now, null);
  assert.equal(banana.stock.batches, 1);
});

test("rules answer follows the question: variety, urgent, stock, free, Marathi crop names", () => {
  const packet = boardForAnalyst(BOARD);
  const taiwan = rulesAnswer(packet, "How is papaya taiwan?");
  assert.match(taiwan, /^Papaya – Taiwan: 8,200 in shed \(5,200 ready now\)/);
  assert.match(taiwan, /1,200 short, incl\. 5,100 overdue/);
  assert.match(taiwan, /next: 19-10-2026 to 25-10-2026 6,500 ready \(1,500 free\)/);

  assert.match(rulesAnswer(packet, "what is overdue?"), /^Papaya – Taiwan/);
  assert.doesNotMatch(rulesAnswer(packet, "what is overdue?"), /Watermelon/);

  const stock = rulesAnswer(packet, "shed stock").split("\n");
  assert.equal(stock.length, 2);
  assert.match(stock[1], /^Banana – G9: 1,729 in shed \(1,500 ready now\) · no sowing, shed stock only$/);

  assert.match(rulesAnswer(packet, "what can we sell?"), /^Watermelon – Impact/);
  assert.match(rulesAnswer(packet, "केळी किती आहे?"), /^Banana – G9/);
  assert.equal(rulesAnswer(packet, "hello"), "");
});

test("answer focus gives a title and the rows to show as cards", () => {
  const packet = boardForAnalyst(BOARD);
  assert.deepEqual(answerFocus(packet, "shed stock"), {
    title: "9,929 plants in sheds",
    rows: [packet.varieties[0], packet.varieties[2]],
    stockOnly: true,
  });
  assert.equal(answerFocus(packet, "papaya taiwan").title, "Papaya – Taiwan");
  assert.equal(answerFocus(packet, "what is overdue").title, "1 overdue or short now");
  assert.equal(answerFocus(packet, "hello").rows.length, 0);
  const mentioned = rowsMentioned(packet, "Papaya – Taiwan is short. केळी G9 has stock.");
  assert.deepEqual(
    mentioned.map((row) => row.variety),
    ["Taiwan", "G9"]
  );
});

test("parser keeps the model answer and accepts an answer without action", () => {
  const parsed = parseAnalystJson('{"answer":"Papaya – Taiwan: 1,200 short"}');
  assert.equal(parsed.action, "wait");
  assert.equal(parsed.answer, "Papaya – Taiwan: 1,200 short");
});

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
