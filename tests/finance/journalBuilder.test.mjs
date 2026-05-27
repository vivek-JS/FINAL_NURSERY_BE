import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JournalBuilder } from "../../modules/finance/posting/journalBuilder.js";

describe("JournalBuilder", () => {
  it("balances simple AR sale", () => {
    const b = new JournalBuilder();
    b.dr("AR_FARMER", 1000, { partyType: "FARMER", partyId: "9999999999" });
    b.cr("SALES_PLANTS", 1000);
    const { totalDebit, totalCredit } = b.assertBalanced();
    assert.equal(totalDebit, 1000);
    assert.equal(totalCredit, 1000);
  });

  it("rejects unbalanced journal", () => {
    const b = new JournalBuilder();
    b.dr("AR_FARMER", 100);
    b.cr("SALES_PLANTS", 50);
    assert.throws(() => b.assertBalanced());
  });
});
