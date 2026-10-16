import { describe, it } from "node:test";
import assert from "node:assert/strict";
import moment from "moment";
import {
  englishShedName,
  groupStockForNotes,
  resolveNoteItems,
  noteTitle,
  toWesternDigits,
} from "../services/secondaryStockNotes.service.js";

const today = moment("2026-10-16", "YYYY-MM-DD").startOf("day");

const line = (over = {}) => ({
  batchId: "b1",
  batchNumber: "RB 19",
  plantLabel: "Banana",
  subtypeLabel: "G9",
  pollyhouse: "Devgiri",
  size: "R1",
  availableQuantity: 100,
  dispatchEligible: true,
  secondaryInwardDate: "2026-09-01T00:00:00.000Z",
  expectedReadyByCalendar: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("englishShedName", () => {
  it("drops the Marathi part and keeps the shed number", () => {
    assert.equal(englishShedName("Purandar (पुरंदर) (6)"), "Purandar (6)");
    assert.equal(englishShedName("Shed A"), "Shed A");
    assert.equal(englishShedName(""), "Unknown");
  });
});

describe("groupStockForNotes", () => {
  it("merges lines of the same batch, shed and size", () => {
    const g = groupStockForNotes(
      [line(), line({ availableQuantity: 50, dispatchEligible: false })],
      today
    );
    assert.equal(g.length, 1);
    assert.equal(g[0].plants, 150);
    assert.equal(g[0].readyPlants, 100);
    assert.equal(g[0].crop, "Banana G9");
  });

  it("computes age and overdue days", () => {
    const [g] = groupStockForNotes([line()], today);
    assert.equal(g.ageDays, 45);
    assert.equal(g.overdueDays, 15);
    assert.equal(g.daysUntilReady, 0);
  });

  it("sorts most overdue first and skips empty lines", () => {
    const g = groupStockForNotes(
      [
        line({ batchId: "new", batchNumber: "RB 50", expectedReadyByCalendar: "2026-10-20T00:00:00.000Z" }),
        line({ batchId: "old", batchNumber: "RB 1", expectedReadyByCalendar: "2026-09-20T00:00:00.000Z" }),
        line({ batchId: "zero", availableQuantity: 0 }),
      ],
      today
    );
    assert.deepEqual(g.map((x) => x.batch), ["RB 1", "RB 50"]);
    assert.equal(g[1].daysUntilReady, 4);
  });
});

describe("resolveNoteItems", () => {
  const groups = groupStockForNotes(
    [
      line(),
      line({ size: "R3", availableQuantity: 40 }),
      line({ pollyhouse: "Torna (तोरणा) (5)", availableQuantity: 70 }),
      line({ batchId: "b2", batchNumber: "VS 911", pollyhouse: "Raigad (2)", availableQuantity: 500, expectedReadyByCalendar: "2026-08-01T00:00:00.000Z" }),
    ],
    today
  );

  it("merges sizes and takes numbers from stock, not the AI", () => {
    const items = resolveNoteItems([{ batch: "rb 19", shed: "Devgiri" }], groups);
    assert.equal(items.length, 1);
    assert.equal(items[0].plants, 140);
    assert.equal(items[0].overdueDays, 15);
  });

  it("expands a batch-only ref to every shed, most overdue first", () => {
    const items = resolveNoteItems([{ batch: "RB 19" }], groups);
    assert.deepEqual(items.map((r) => r.shed), ["Devgiri", "Torna (5)"]);
  });

  it("falls back to the point's batch/shed and ignores unknown refs", () => {
    assert.equal(resolveNoteItems([], groups, { shed: "Raigad (2)" })[0].batch, "VS 911");
    assert.deepEqual(resolveNoteItems([{ batch: "NOPE", shed: "X" }], groups), []);
  });
});

describe("noteTitle", () => {
  const item = (batch, shed) => ({ batch, shed });

  it("prefixes the single batch with its CMS code", () => {
    assert.equal(
      noteTitle("जुना स्टॉक पाठवा", [item("RB 19", "Purandar (6)"), item("RB 19", "Devgiri (8)")]),
      "बॅच RB 19: जुना स्टॉक पाठवा"
    );
  });

  it("uses the English shed name and drops any AI-written prefix", () => {
    assert.equal(
      noteTitle("राजेगड (७): जुना स्टॉक पाठवा", [item("SB 139", "Rajgad (7)"), item("RB 19", "Rajgad (7)")]),
      "Rajgad (7): जुना स्टॉक पाठवा"
    );
  });

  it("leaves the action alone when items span several batches and sheds", () => {
    assert.equal(noteTitle("लवकर पाठवा", [item("A", "X"), item("B", "Y")]), "लवकर पाठवा");
  });
});

describe("toWesternDigits", () => {
  it("converts Devanagari digits", () => {
    assert.equal(toWesternDigits("६० दिवस"), "60 दिवस");
  });
});
