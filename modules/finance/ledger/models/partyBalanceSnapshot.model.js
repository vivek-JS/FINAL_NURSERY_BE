import mongoose from "mongoose";

const partyBalanceSnapshotSchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: "default", index: true },
    partyType: { type: String, required: true, index: true },
    partyId: { type: String, required: true, index: true },
    accountCode: { type: String, required: true },
    asOfDate: { type: Date, required: true, index: true },
    balance: { type: Number, required: true },
    lastJournalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry" },
  },
  { timestamps: true }
);

partyBalanceSnapshotSchema.index(
  { tenantId: 1, partyType: 1, partyId: 1, accountCode: 1, asOfDate: 1 },
  { unique: true }
);

const PartyBalanceSnapshot =
  mongoose.models.PartyBalanceSnapshot ||
  mongoose.model("PartyBalanceSnapshot", partyBalanceSnapshotSchema);

export default PartyBalanceSnapshot;
