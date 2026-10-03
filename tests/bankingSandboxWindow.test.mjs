import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatCibSvStatementDate,
  resolveStatementWindow,
  SANDBOX_STATEMENT_FROM,
  SANDBOX_STATEMENT_TO,
} from "../modules/banking/services/iciciCorporateStatement.service.js";

describe("CIB_SV statement dates", () => {
  it("sends the date as dd-mm-yyyy, the way the UAT sample does", () => {
    assert.equal(formatCibSvStatementDate("2024-01-01"), "01-01-2024");
    assert.equal(formatCibSvStatementDate("2024-02-10"), "10-02-2024");
  });

  it("does not send YYYYMMDD, which the sandbox rejects", () => {
    assert.notEqual(formatCibSvStatementDate("2024-01-01"), "20240101");
  });

  it("leaves a production range alone", () => {
    const w = resolveStatementWindow("2026-10-01", "2026-10-03", { isProd: true, useStub: false });
    assert.equal(w.clamped, false);
    assert.equal(w.fromDate, "2026-10-01");
  });

  it("swaps today's dates for the canned sandbox window", () => {
    const w = resolveStatementWindow("2026-09-26", "2026-10-03", { isProd: false, useStub: false });
    assert.equal(w.clamped, true);
    assert.equal(w.fromDate, SANDBOX_STATEMENT_FROM);
    assert.equal(w.toDate, SANDBOX_STATEMENT_TO);
  });

  it("keeps a range that already sits inside the sandbox window", () => {
    const w = resolveStatementWindow("2024-01-15", "2024-01-20", { isProd: false, useStub: false });
    assert.equal(w.clamped, false);
    assert.equal(w.fromDate, "2024-01-15");
    assert.equal(w.toDate, "2024-01-20");
  });
});
