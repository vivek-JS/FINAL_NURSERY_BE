import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

describe("LedgerLine immutability", () => {
  it("schema blocks updateOne", async () => {
    const { default: LedgerLine } = await import(
      "../../modules/finance/ledger/models/ledgerLine.model.js"
    );
    const doc = new LedgerLine({
      journalEntryId: new mongoose.Types.ObjectId(),
      accountId: new mongoose.Types.ObjectId(),
      accountCode: "CASH",
      debit: 1,
      credit: 0,
      entryDate: new Date(),
    });

    let err;
    try {
      await doc.validate();
      await LedgerLine.updateOne({ _id: doc._id }, { $set: { debit: 2 } });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected updateOne to throw");
    assert.match(String(err.message), /immutable/i);
  });
});
