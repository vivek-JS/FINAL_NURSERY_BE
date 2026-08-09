import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSalesSheetTotalsRow,
  SALES_SHEET_COLUMNS,
} from "../utility/adminSalesSheetRow.js";

test("sales sheet columns include Dispatch date after delivery dates", () => {
  const keys = SALES_SHEET_COLUMNS.map((c) => c.key);
  assert.ok(keys.includes("dispatchDate"));
  assert.equal(
    keys.indexOf("dispatchDate"),
    keys.indexOf("originalDelDate") + 1
  );
  assert.equal(
    SALES_SHEET_COLUMNS.find((c) => c.key === "dispatchDate")?.label,
    "Dispatch date"
  );
});

test("buildSalesSheetTotalsRow sums qty and amount columns", () => {
  const totals = buildSalesSheetTotalsRow([
    { issuePlantQty: 100, invAmount: 5000, total: 5200 },
    { issuePlantQty: 50, invAmount: 2500, total: 2600 },
  ]);
  assert.equal(totals.customerName, "Total");
  assert.equal(totals.srNo, "");
  assert.equal(totals.issuePlantQty, 150);
  assert.equal(totals.invAmount, 7500);
  assert.equal(totals.total, 7800);
});
