import mongoose from "mongoose";
import PlantSlot from "../../models/slots.model.js";
import { upsertSowingEntryFromBatch } from "./saveSowingEntry.js";

function oid(value) {
  const text = String(value || "");
  return mongoose.Types.ObjectId.isValid(text) ? new mongoose.Types.ObjectId(text) : null;
}

/** After excess cover or reverse, copy each live slot batch onto its sowing entry. */
export async function syncSowingEntriesForPicks(picks = [], session = null) {
  for (const pick of picks) {
    const batchId = oid(pick?.batchId);
    if (!batchId) continue;
    const agg = PlantSlot.aggregate([
      { $match: { "subtypeSlots.slots.sowingBatches._id": batchId } },
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      { $unwind: "$subtypeSlots.slots.sowingBatches" },
      { $match: { "subtypeSlots.slots.sowingBatches._id": batchId } },
      {
        $project: {
          slotId: "$subtypeSlots.slots._id",
          batch: "$subtypeSlots.slots.sowingBatches",
        },
      },
      { $limit: 1 },
    ]);
    if (session) agg.session(session);
    const rows = await agg;
    const row = rows[0];
    if (!row?.batch) continue;
    await upsertSowingEntryFromBatch(row.batch, row.slotId || pick.slotId, session);
  }
}
