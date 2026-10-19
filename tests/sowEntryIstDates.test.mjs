import test from "node:test";
import assert from "node:assert/strict";
import { toSowYmd, istTodayNoon, fmtDDMMYYYY } from "../controllers/sowingSlotReadyHelpers.js";
import { earliestSowYmd } from "../services/orderExcessBatchCover.service.js";

test("toSowYmd keeps day strings as-is and reads Dates in IST", () => {
  assert.equal(toSowYmd("2026-10-06"), "2026-10-06");
  assert.equal(toSowYmd("17-10-2026"), "2026-10-17");
  assert.equal(toSowYmd(new Date("2026-10-16T20:00:00Z")), "2026-10-17");
  assert.equal(toSowYmd(new Date("2026-10-16T18:00:00Z")), "2026-10-16");
  assert.equal(toSowYmd(""), "");
  assert.equal(toSowYmd(null), "");
  assert.equal(toSowYmd("not a date"), "");
});

test("istTodayNoon gives the IST calendar day just after midnight IST", () => {
  const d = istTodayNoon(new Date("2026-10-16T20:00:00Z"));
  assert.equal(fmtDDMMYYYY(d), "17-10-2026");
  assert.equal(toSowYmd(d), "2026-10-17");
});

test("earliestSowYmd picks the oldest source batch sow day", () => {
  assert.equal(
    earliestSowYmd([{ sowingDate: "06-10-2026" }, { sowingDate: "2026-10-03" }, { sowingDate: "" }]),
    "2026-10-03"
  );
  assert.equal(earliestSowYmd([{ sowingDate: "" }]), null);
  assert.equal(earliestSowYmd([]), null);
});
