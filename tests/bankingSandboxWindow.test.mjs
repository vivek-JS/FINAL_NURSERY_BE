import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectStatementPages,
  formatCibSvStatementDate,
  lastTransactionIdOf,
  resolveStatementWindow,
  SANDBOX_STATEMENT_FROM,
  SANDBOX_STATEMENT_TO,
} from "../modules/banking/services/iciciCorporateStatement.service.js";
import { bankDay, isSameLine, lineSignature } from "../modules/banking/services/duplicateDetection.service.js";
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

describe("statement pagination (CONFLG / LASTTRID)", () => {
  const page = (ids, lastTrId) => ({
    RESPONSE: "SUCCESS",
    Record: ids.map((id) => ({ TXNDATE: "01-01-2024", AMOUNT: "1.00", TYPE: "CR", TRANSACTIONID: id })),
    ...(lastTrId ? { LASTTRID: lastTrId } : {}),
  });

  it("reads LASTTRID and ICICI's LISTTRID spelling, exactly as sent", () => {
    assert.equal(lastTransactionIdOf({ LISTTRID: "1|S25587116|03-07-2015 00:00:00|INR" }), "1|S25587116|03-07-2015 00:00:00|INR");
    assert.equal(lastTransactionIdOf({ lastTrId: " x " }), " x ");
    assert.equal(lastTransactionIdOf({ RESPONSE: "SUCCESS" }), "");
  });

  it("follows pages until ICICI stops sending a marker", async () => {
    const calls = [];
    const pages = [page(["A", "B"], "1|B"), page(["C"], "1|C"), page(["D"])];
    const res = await collectStatementPages(async (q) => {
      calls.push(q);
      return pages[calls.length - 1];
    });
    assert.deepEqual(calls.map((c) => [c.conflg, c.lastTrId]), [["N", ""], ["Y", "1|B"], ["Y", "1|C"]]);
    assert.equal(res.rows.length, 4);
    assert.equal(res.pages, 3);
    assert.equal(res.complete, true);
  });

  it("keeps earlier pages and flags the gap when a later page fails", async () => {
    let n = 0;
    const res = await collectStatementPages(async () => {
      n += 1;
      if (n === 1) return page(["A"], "1|A");
      throw new Error("timeout");
    });
    assert.equal(res.rows.length, 1);
    assert.equal(res.complete, false);
    assert.match(res.warning, /sync again/);
  });

  it("stops if ICICI repeats the same marker", async () => {
    const res = await collectStatementPages(async () => page(["A"], "1|A"));
    assert.equal(res.pages, 2);
    assert.equal(res.complete, false);
  });

  it("stops at the page cap", async () => {
    let n = 0;
    const res = await collectStatementPages(async () => page([`T${++n}`], `m${n}`), { maxPages: 3 });
    assert.equal(res.pages, 3);
    assert.equal(res.complete, false);
  });
});

describe("statement line identity", () => {
  const sig = (p) =>
    lineSignature({ accountNumber: "1", amount: 500, txnDate: new Date(Date.UTC(2026, 9, 10)), ...p });

  it("uses the India calendar day", () => {
    assert.equal(bankDay(new Date("2026-10-09T19:00:00Z")), "2026-10-10");
    assert.equal(bankDay(new Date(Date.UTC(2026, 9, 10))), "2026-10-10");
  });

  it("decides by ICICI transaction id when both have one", () => {
    assert.equal(isSameLine(sig({ transactionId: "S1" }), sig({ transactionId: "S1" })), true);
    assert.equal(isSameLine(sig({ transactionId: "S1", narration: "CASH" }), sig({ transactionId: "S2", narration: "CASH" })), false);
  });

  it("matches by UTR, or a UTR found in the other line's narration", () => {
    assert.equal(isSameLine(sig({ referenceNumber: "373122371894" }), sig({ referenceNumber: "373122371894" })), true);
    assert.equal(isSameLine(sig({ referenceNumber: "373122371894" }), sig({ narration: "UPI/373122371894/x" })), true);
    assert.equal(isSameLine(sig({ referenceNumber: "373122371894" }), sig({ referenceNumber: "373122370000" })), false);
  });

  it("never matches a different amount or day", () => {
    assert.equal(isSameLine(sig({ referenceNumber: "U1" }), sig({ referenceNumber: "U1", amount: 501 })), false);
    assert.equal(
      isSameLine(sig({ referenceNumber: "U1" }), sig({ referenceNumber: "U1", txnDate: new Date(Date.UTC(2026, 9, 11)) })),
      false
    );
  });
});
