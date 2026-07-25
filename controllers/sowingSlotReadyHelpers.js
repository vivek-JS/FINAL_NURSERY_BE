import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import PlantCms from "../models/plantCms.model.js";

/** Parse YYYY-MM-DD or DD-MM-YYYY to local noon Date. */
export function parseLocalDate(input) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) return input;
  const s = String(input || "").trim();
  if (!s) return null;
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) {
    return new Date(
      parseInt(ymd[1], 10),
      parseInt(ymd[2], 10) - 1,
      parseInt(ymd[3], 10),
      12,
      0,
      0,
      0
    );
  }
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (dmy) {
    return new Date(
      parseInt(dmy[3], 10),
      parseInt(dmy[2], 10) - 1,
      parseInt(dmy[1], 10),
      12,
      0,
      0,
      0
    );
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDDMMYYYY(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

export function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + Math.max(0, Number(days) || 0));
  return d;
}

function parseDdMmYyyy(str) {
  const m = String(str || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return new Date(
    parseInt(m[3], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[1], 10),
    12,
    0,
    0,
    0
  );
}

export async function resolveCmsReadyDays(plantId, subtypeId) {
  if (!plantId || !subtypeId) return 0;
  try {
    const plant = await PlantCms.findById(plantId).select("subtypes").lean();
    const st = (plant?.subtypes || []).find(
      (s) => String(s._id || s.subtypeId) === String(subtypeId)
    );
    return Number(st?.plantReadyDays) || 0;
  } catch {
    return 0;
  }
}

/**
 * Find calendar slot where plantReadyDate falls in [startDay, endDay].
 * Same idea as admin_daywise mapping in sowing.controller.js.
 */
export async function findSlotByPlantReadyDate(plantId, subtypeId, plantReadyDate) {
  const ready =
    plantReadyDate instanceof Date
      ? plantReadyDate
      : parseLocalDate(plantReadyDate) || parseDdMmYyyy(plantReadyDate);
  if (!ready || !plantId || !subtypeId) return null;

  const readyStr = fmtDDMMYYYY(ready);
  const readyMs = ready.setHours(12, 0, 0, 0);

  const docs = await PlantSlot.find({
    plantId: new mongoose.Types.ObjectId(plantId),
    "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
  })
    .select("subtypeSlots year")
    .lean();

  for (const doc of docs || []) {
    const st = (doc.subtypeSlots || []).find(
      (s) => String(s.subtypeId) === String(subtypeId)
    );
    if (!st?.slots?.length) continue;
    for (const slot of st.slots) {
      const start = parseDdMmYyyy(slot.startDay);
      const end = parseDdMmYyyy(slot.endDay);
      if (!start || !end) continue;
      const a = start.setHours(0, 0, 0, 0);
      const b = end.setHours(23, 59, 59, 999);
      if (readyMs >= a && readyMs <= b) {
        return {
          slotId: slot._id,
          startDay: slot.startDay,
          endDay: slot.endDay,
          plantReadyDays: Number(slot.plantReadyDays) || 0,
          plantReadyDate: readyStr,
        };
      }
    }
  }
  return null;
}

export function resolveReadyDays(metaReadyDays, slotReadyDays, cmsReadyDays) {
  const override = Number(metaReadyDays);
  if (Number.isFinite(override) && override > 0) return override;
  if (Number(slotReadyDays) > 0) return Number(slotReadyDays);
  return Number(cmsReadyDays) || 0;
}
