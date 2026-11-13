import SowingEntry from "../../models/sowingEntry.model.js";
import { boardGroup, boardToday, rowsFromEntries } from "./boardExcessFromEntries.js";

const FIELDS = [
  "plantId",
  "subtypeId",
  "plantReadyDate",
  "plantsSowed",
  "orderCoveredPlants",
  "bufferPlants",
  "sowingBufferPct",
  "excessPlants",
  "mortalityMovedToExcess",
  "excessMovedToMortality",
  "noMortalityReserve",
  "isIrrelevant",
].join(" ");

/** GET /sowing/entries/board-excess?group= — compare excess for the live capacity tab. */
export async function getEntriesBoardExcess(req, res) {
  const today = boardToday();
  const docs = await SowingEntry.find({ isIrrelevant: { $ne: true } }).select(FIELDS).lean();
  return res.json({
    success: true,
    source: "sowingentries",
    today: today.format("YYYY-MM-DD"),
    groupDays: boardGroup(req.query.group),
    rows: rowsFromEntries(docs, { today, groupDays: req.query.group }),
  });
}
