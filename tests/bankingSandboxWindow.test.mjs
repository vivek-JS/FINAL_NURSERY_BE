import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatCibSvStatementDate,
  resolveStatementWindow,
  SANDBOX_STATEMENT_FROM,
  SANDBOX_STATEMENT_TO,
} from "../modules/banking/services/iciciCorporateStatement.service.js";
import { normaliseStatementRow } from "../services/iciciStatement.service.js";

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

describe("CIB_SV Record rows", () => {
  it("treats TYPE=CR as a credit and pulls the UTR from remarks", () => {
    const row = normaliseStatementRow({
      TXNDATE: "31-12-2023 05:03:33",
      REMARKS: "UPI/373122371894/rakesh kothapal/IDFC",
      AMOUNT: "2.00",
      BALANCE: "10,852.22",
      TYPE: "CR",
      TRANSACTIONID: "C36887466",
      CHEQUENO: "",
    });
    assert.equal(row.amount, 2);
    assert.equal(row.txnType, "CR");
    assert.equal(row.referenceNumber, "373122371894");
    assert.equal(row.transactionId, "C36887466");
    assert.equal(row.balance, 10852.22);
    assert.equal(row.txnDate.getUTCDate(), 31);
    assert.equal(row.txnDate.getUTCMonth(), 11);
  });

  it("treats TYPE=DR as a negative amount", () => {
    const row = normaliseStatementRow({
      TXNDATE: "01-01-2024",
      REMARKS: "INF/NEFT/034858232391/SBIN0020242/H",
      AMOUNT: "1.23",
      TYPE: "DR",
    });
    assert.equal(row.amount, -1.23);
    assert.equal(row.referenceNumber, "034858232391");
  });
});
