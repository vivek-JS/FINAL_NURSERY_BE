import { describe, it } from "node:test";
import assert from "node:assert/strict";
import moment from "moment";
import { groupStockForNotes } from "../services/secondaryStockNotes.service.js";

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
