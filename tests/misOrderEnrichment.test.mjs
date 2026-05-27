import test from "node:test";
import assert from "node:assert/strict";
import {
  firstTransitionDate,
  enrichMisOrderRow,
} from "../utility/misOrderEnrichment.js";

test("firstTransitionDate returns earliest DISPATCHED", () => {
  const order = {
    statusChanges: [
      { newStatus: "DISPATCHED", createdAt: new Date("2026-05-25T10:00:00Z") },
      { newStatus: "DISPATCHED", createdAt: new Date("2026-05-20T10:00:00Z") },
    ],
  };
  const d = firstTransitionDate(order, "DISPATCHED");
  assert.equal(d.toISOString(), new Date("2026-05-20T10:00:00Z").toISOString());
});

test("enrichMisOrderRow adds dispatchedDate and bucketEventAt for completed", () => {
  const row = enrichMisOrderRow(
    {
      orderId: 1,
      statusChanges: [
        { newStatus: "DISPATCHED", createdAt: new Date("2026-05-22") },
        { newStatus: "COMPLETED", createdAt: new Date("2026-05-28") },
      ],
    },
    { bucket: "completed", bucketEventAt: new Date("2026-05-28") }
  );
  assert.ok(row.dispatchedDate);
  assert.ok(row.completedDate);
  assert.ok(row.bucketEventAt);
});
