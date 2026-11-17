import mongoose from "mongoose";
import SowingEntry from "../../models/sowingEntry.model.js";
import { isSuperAdminUser } from "../../services/sowBatchIrrelevant.service.js";
import { entryIrrelevantPatch } from "./saveSowingEntry.js";

/** POST /sowing/entries/:id/irrelevant — { isIrrelevant } (super admin). */
export async function postSowingEntryIrrelevant(req, res) {
  if (!isSuperAdminUser(req.user)) {
    return res.status(403).json({
      success: false,
      message: "Only a super admin can mark a sowing entry old",
    });
  }
  const id = String(req.params.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid entry id" });
  }
  const doc = await SowingEntry.findById(id).lean();
  if (!doc) return res.status(404).json({ success: false, message: "Sowing entry not found" });

  const mark = Boolean(req.body?.isIrrelevant);
  const patch = entryIrrelevantPatch(doc, mark);
  await SowingEntry.updateOne({ _id: doc._id }, { $set: patch });
  return res.status(200).json({
    success: true,
    message: mark ? "Marked old" : "Restored entry",
    id: String(doc._id),
    isIrrelevant: patch.isIrrelevant,
  });
}
