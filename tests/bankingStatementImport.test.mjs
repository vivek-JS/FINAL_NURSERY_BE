import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseStatementCsv,
  parseStatementDate,
  parseAmount,
  splitCsvLine,
  extractReference,
} from "../modules/banking/utils/statementCsv.js";

describe("splitting a CSV line", () => {
  it("keeps commas that sit inside quotes", () => {
    assert.deepEqual(splitCsvLine('01/04/2026,"NEFT, inward",1500'), [
      "01/04/2026",
      "NEFT, inward",
      "1500",
    ]);
  });

  it("unescapes doubled quotes", () => {
    assert.deepEqual(splitCsvLine('a,"he said ""hi""",b'), ["a", 'he said "hi"', "b"]);
  });

  it("handles tab separated exports", () => {
    assert.deepEqual(splitCsvLine("01/04/2026\tUPI\t1500"), ["01/04/2026", "UPI", "1500"]);
  });
});

describe("reading an amount the way a bank prints it", () => {
  it("strips grouping, currency and whitespace", () => {
    assert.equal(parseAmount("1,23,456.78"), 123456.78);
    assert.equal(parseAmount("₹ 1,500.00"), 1500);
  });

  it("treats Dr, a leading minus and brackets as negative", () => {
    assert.equal(parseAmount("250.00 Dr"), -250);
    assert.equal(parseAmount("-250"), -250);
    assert.equal(parseAmount("(250.00)"), -250);
  });

  it("keeps Cr positive", () => {
    assert.equal(parseAmount("1500.00 Cr"), 1500);
  });

  it("returns null for blanks and dashes rather than zero", () => {
    // Zero would look like a real ₹0 transaction and get imported.
    for (const blank of ["", "   ", "-", "—", null, undefined]) {
      assert.equal(parseAmount(blank), null, `${JSON.stringify(blank)} should not parse`);
    }
  });
});

describe("reading a date the way an Indian bank prints it", () => {
  it("reads an ambiguous date as day first", () => {
    const d = parseStatementDate("03/04/2026");
    assert.equal(d.getUTCDate(), 3);
    assert.equal(d.getUTCMonth(), 3, "April");
  });

  it("reads ISO exactly, not day first", () => {
    const d = parseStatementDate("2026-04-03");
    assert.equal(d.getUTCDate(), 3);
    assert.equal(d.getUTCMonth(), 3);
  });

  it("reads named months and two digit years", () => {
    const d = parseStatementDate("03-Apr-26");
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 3);
  });

  it("rejects an impossible month instead of rolling it over", () => {
    assert.equal(parseStatementDate("03/13/2026"), null);
    assert.equal(parseStatementDate("not a date"), null);
    assert.equal(parseStatementDate(""), null);
  });
});

describe("finding the reference when the column is blank", () => {
  it("prefers the reference column", () => {
    assert.equal(extractReference("412345678901", "UPI/CR/999/X"), "412345678901");
  });

  it("digs a UTR out of the narration", () => {
    assert.equal(extractReference("", "UPI/CR/412345678901/RAHUL/HDFC"), "412345678901");
    assert.equal(extractReference("-", "NEFT SBIN0001234567890 SALARY"), "SBIN0001234567890");
  });

  it("returns empty rather than guessing at a short number", () => {
    assert.equal(extractReference("", "CASH DEPOSIT 500"), "");
  });
});

describe("parsing a whole statement export", () => {
  const ICICI_EXPORT = [
    "Statement of Transactions in Savings Account 000405001234",
    "Period: 01/04/2026 to 03/04/2026",
    "",
    "Txn Date,Value Date,Description,Ref No./Cheque No.,Debit,Credit,Balance",
    "01/04/2026,01/04/2026,UPI/CR/412345678901/RAHUL,412345678901,,1500.00,51500.00",
    '02/04/2026,02/04/2026,"NEFT, inward ACME LTD",SBIN0001234567,,25000.00,76500.00',
    "02/04/2026,02/04/2026,ATM WDL,,2000.00,,74500.00",
    "03/04/2026,03/04/2026,CASH DEPOSIT,,,500.00,75000.00",
    "Total,,,,2000.00,27000.00,",
  ].join("\n");

  it("skips the preamble and reads every transaction", () => {
    const out = parseStatementCsv(ICICI_EXPORT);
    assert.equal(out.ok, true, out.error);
    assert.equal(out.rows.length, 4);
  });

  it("signs credits positive and debits negative", () => {
    const { rows } = parseStatementCsv(ICICI_EXPORT);
    assert.deepEqual(
      rows.map((r) => r.amount),
      [1500, 25000, -2000, 500]
    );
    assert.deepEqual(
      rows.map((r) => r.txnType),
      ["CREDIT", "CREDIT", "DEBIT", "CREDIT"]
    );
  });

  it("carries the reference through so a UTR can match later", () => {
    const { rows } = parseStatementCsv(ICICI_EXPORT);
    assert.equal(rows[0].referenceNumber, "412345678901");
    assert.equal(rows[1].referenceNumber, "SBIN0001234567");
    assert.equal(rows[3].referenceNumber, "", "cash deposit has no reference");
  });

  it("drops the totals footer instead of importing it as a transaction", () => {
    const { rows } = parseStatementCsv(ICICI_EXPORT);
    assert.ok(
      rows.every((r) => r.narration !== "Total"),
      "the Total line must not become a statement entry"
    );
  });

  it("reads an export that uses one signed amount column", () => {
    const csv = ["Date,Narration,Reference,Amount", "01/04/2026,UPI inward,UTR1,1500", "02/04/2026,Fee,,-50"].join("\n");
    const out = parseStatementCsv(csv);
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(
      out.rows.map((r) => r.amount),
      [1500, -50]
    );
  });

  it("reads Withdrawal and Deposit column names", () => {
    const csv = [
      "Transaction Date,Particulars,Cheque No,Withdrawal Amt,Deposit Amt,Closing Balance",
      "01/04/2026,CHEQUE CLEARING,123456,,7500.00,57500.00",
    ].join("\n");
    const out = parseStatementCsv(csv);
    assert.equal(out.ok, true, out.error);
    assert.equal(out.rows[0].amount, 7500);
    assert.equal(out.rows[0].referenceNumber, "123456");
  });

  it("explains itself when the file is not a statement", () => {
    const out = parseStatementCsv("name,qty\nwidget,3");
    assert.equal(out.ok, false);
    assert.match(out.error, /header row/i);
  });

  it("explains itself when the file is empty", () => {
    const out = parseStatementCsv("");
    assert.equal(out.ok, false);
    assert.match(out.error, /empty/i);
  });

  it("reports an unreadable date rather than silently dropping money", () => {
    const csv = [
      "Txn Date,Description,Ref No,Debit,Credit,Balance",
      "01/04/2026,good,UTR1,,100.00,100.00",
      "garbled,bad row,UTR2,,200.00,300.00",
    ].join("\n");
    const out = parseStatementCsv(csv);
    assert.equal(out.rows.length, 1);
    assert.equal(out.skipped.length, 1);
    assert.match(out.skipped[0].reason, /date/);
  });
});
