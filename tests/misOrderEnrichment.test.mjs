import test from "node:test";
import assert from "node:assert/strict";
import {
  pickDispatchLegForBucket,
  enrichMisOrderRow,
} from "../utility/misOrderEnrichment.js";

test("pickDispatchLegForBucket picks leg near bucketEventAt", () => {
  const at = new Date("2026-05-26T10:16:50.574Z");
  const order = {
    dispatchHistory: [
      { date: new Date("2026-05-20T00:00:00Z"), vehicleName: "Old" },
      { date: at, vehicleName: "MH-12-AB-1234", driverName: "Ram" },
    ],
  };
  const leg = pickDispatchLegForBucket(order, at);
  assert.equal(leg.vehicleName, "MH-12-AB-1234");
});

test("enrichMisOrderRow uses bucketEventAt for dispatched display", () => {
  const at = new Date("2026-05-27T07:15:23.449Z");
  const row = enrichMisOrderRow(
    {
      statusChanges: [
        { newStatus: "DISPATCHED", createdAt: new Date("2026-05-01T00:00:00Z") },
      ],
    },
    { bucket: "dispatched", bucketEventAt: at }
  );
  assert.equal(row.dispatchedDate?.toISOString(), at.toISOString());
});
