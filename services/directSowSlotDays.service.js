import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";

function ddMmYyyyToYmd(str) {
  const m = String(str || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return "";
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * All calendar slots per subtype (unique slotId) for direct-sow slot cards.
 */
export async function fetchSlotsBySubtype(plantId, subtypeIds = []) {
  const out = new Map();
  if (!plantId || !subtypeIds.length) return out;

  const oid = new mongoose.Types.ObjectId(plantId);
  const stOids = subtypeIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!stOids.length) return out;

  const docs = await PlantSlot.find({
    plantId: oid,
    "subtypeSlots.subtypeId": { $in: stOids },
  })
    .select("subtypeSlots year")
    .lean();

  for (const doc of docs || []) {
    for (const st of doc.subtypeSlots || []) {
      const sid = String(st.subtypeId);
      if (!stOids.some((id) => String(id) === sid)) continue;
      if (!out.has(sid)) out.set(sid, []);
      const list = out.get(sid);
      const seen = new Set(list.map((x) => String(x.slotId)));
      for (const slot of st.slots || []) {
        const slotId = slot._id;
        if (!slotId || seen.has(String(slotId))) continue;
        seen.add(String(slotId));
        list.push({
          slotId,
          deliveryKey: ddMmYyyyToYmd(slot.startDay),
          startDay: slot.startDay,
          endDay: slot.endDay || slot.startDay,
          month: slot.month || "",
          year: slot.year ?? doc.year,
          totalBookedPlants: Number(slot.totalBookedPlants) || 0,
          primarySowed: Number(slot.primarySowed) || 0,
          officeSowed: Number(slot.officeSowed) || 0,
          plantReadyDays: Number(slot.plantReadyDays) || 0,
        });
      }
    }
  }

  for (const list of out.values()) {
    list.sort((a, b) => {
      const ka = a.deliveryKey || "";
      const kb = b.deliveryKey || "";
      return ka.localeCompare(kb);
    });
  }
  return out;
}

/** @deprecated use fetchSlotsBySubtype */
export const fetchSlotDaysBySubtype = fetchSlotsBySubtype;
