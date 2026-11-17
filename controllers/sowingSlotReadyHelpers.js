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

/** Today's IST calendar day as a local-noon Date (server runs in UTC). */
export function istTodayNoon(now = new Date()) {
  return parseLocalDate(now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
}

/** Sow day as "YYYY-MM-DD": day strings keep their calendar day, Dates use IST. */
export function toSowYmd(input) {
  if (input == null || input === "") return "";
  if (!(input instanceof Date)) {
    const s = String(input).trim();
    const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
    const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
    if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  }
  const d = new Date(input);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + Math.max(0, Number(days) || 0));
  return d;
}

function parseDdMmYyyy(str) {
  // Prefer shared parser (YYYY-MM-DD or DD-MM-YYYY).
  return parseLocalDate(str);
}

/**
 * Nearest calendar slot for a ready date when exact window match is missing.
 * Prefers slot whose [start,end] is closest after/before readyMs.
 */
export async function findNearestSlotForReadyDate(
  plantId,
  subtypeId,
  plantReadyDate
) {
  const ready =
    plantReadyDate instanceof Date
      ? plantReadyDate
      : parseLocalDate(plantReadyDate) || parseDdMmYyyy(plantReadyDate);
  if (!ready || !plantId || !subtypeId) return null;

  const readyStr = fmtDDMMYYYY(ready);
  const readyMs = new Date(ready).setHours(12, 0, 0, 0);

  const docs = await PlantSlot.find({
    plantId: new mongoose.Types.ObjectId(plantId),
    "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
  })
    .select("subtypeSlots year")
    .lean();

  let best = null;
  let bestDist = Infinity;

  for (const doc of docs || []) {
    const st = (doc.subtypeSlots || []).find(
      (s) => String(s.subtypeId) === String(subtypeId)
    );
    if (!st?.slots?.length) continue;
    for (const slot of st.slots) {
      const start = parseDdMmYyyy(slot.startDay);
      const end = parseDdMmYyyy(slot.endDay) || start;
      if (!start) continue;
      const a = new Date(start).setHours(0, 0, 0, 0);
      const b = new Date(end).setHours(23, 59, 59, 999);
      let dist = 0;
      if (readyMs >= a && readyMs <= b) dist = 0;
      else if (readyMs < a) dist = a - readyMs;
      else dist = readyMs - b;
      if (dist < bestDist) {
        bestDist = dist;
        best = {
          slotId: slot._id,
          startDay: slot.startDay,
          endDay: slot.endDay,
          plantReadyDays: Number(slot.plantReadyDays) || 0,
          plantReadyDate: readyStr,
          nearest: dist > 0,
        };
        if (dist === 0) return best;
      }
    }
  }
  return best;
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

/**
 * Ensure a calendar slot exists for this ready day (1-day window).
 * Does not require an existing slot — creates under the plant+year document.
 */
export async function ensureSlotForReadyDate(
  plantId,
  subtypeId,
  plantReadyDate,
  { plantReadyDays = 0, totalPlants = 0 } = {}
) {
  const ready =
    plantReadyDate instanceof Date
      ? plantReadyDate
      : parseLocalDate(plantReadyDate) || parseDdMmYyyy(plantReadyDate);
  if (!ready || !plantId || !subtypeId) return null;

  const readyStr = fmtDDMMYYYY(ready);
  const existing = await findSlotByPlantReadyDate(plantId, subtypeId, readyStr);
  if (existing?.slotId) return { ...existing, created: false };

  const year = ready.getFullYear();
  const monthName = ready.toLocaleString("en-US", { month: "long" });
  const plantOid = new mongoose.Types.ObjectId(plantId);
  const subtypeOid = new mongoose.Types.ObjectId(subtypeId);
  const cmsDays = Number(plantReadyDays) || (await resolveCmsReadyDays(plantId, subtypeId)) || 0;

  let doc = await PlantSlot.findOne({ plantId: plantOid, year });
  if (!doc) {
    doc = await PlantSlot.create({
      plantId: plantOid,
      year,
      subtypeSlots: [{ subtypeId: subtypeOid, slots: [] }],
    });
  }

  let st = (doc.subtypeSlots || []).find((s) => String(s.subtypeId) === String(subtypeOid));
  if (!st) {
    doc.subtypeSlots.push({ subtypeId: subtypeOid, slots: [] });
    st = doc.subtypeSlots[doc.subtypeSlots.length - 1];
  }

  const dup = (st.slots || []).find((s) => {
    const a = parseDdMmYyyy(s.startDay);
    const b = parseDdMmYyyy(s.endDay) || a;
    if (!a) return false;
    const ms = new Date(ready).setHours(12, 0, 0, 0);
    return ms >= new Date(a).setHours(0, 0, 0, 0) && ms <= new Date(b).setHours(23, 59, 59, 999);
  });
  if (dup?._id) {
    return {
      slotId: dup._id,
      startDay: dup.startDay,
      endDay: dup.endDay,
      plantReadyDays: Number(dup.plantReadyDays) || cmsDays,
      plantReadyDate: readyStr,
      created: false,
    };
  }

  st.slots.push({
    startDay: readyStr,
    endDay: readyStr,
    month: monthName,
    totalPlants: Math.max(0, Number(totalPlants) || 0),
    totalBookedPlants: 0,
    availablePlants: Math.max(0, Number(totalPlants) || 0),
    buffer: 0,
    orders: [],
    status: true,
    isManual: true,
    plantReadyDays: cmsDays,
    sowingBatches: [],
  });
  // Old slots on this year doc can already be below 0. A full save rechecks every slot
  // and then Complete sow fails before the new ready day is created.
  for (const subtype of doc.subtypeSlots || []) {
    for (const slot of subtype?.slots || []) {
      const reserved = Number(slot?.orderReservedPlants);
      if (Number.isFinite(reserved) && reserved < 0) slot.orderReservedPlants = 0;
    }
  }
  await doc.save({ validateModifiedOnly: true });
  const created = st.slots[st.slots.length - 1];
  return {
    slotId: created._id,
    startDay: readyStr,
    endDay: readyStr,
    plantReadyDays: cmsDays,
    plantReadyDate: readyStr,
    created: true,
  };
}

/** Exact ready-day slot, else create one. Does not fall back to a wrong nearest day. */
export async function findOrCreateSlotForReadyDate(
  plantId,
  subtypeId,
  plantReadyDate,
  opts = {}
) {
  const readyStr =
    plantReadyDate instanceof Date
      ? fmtDDMMYYYY(plantReadyDate)
      : String(plantReadyDate || "").match(/^\d{2}-\d{2}-\d{4}$/)
        ? String(plantReadyDate)
        : (() => {
            const d = parseLocalDate(plantReadyDate);
            return d ? fmtDDMMYYYY(d) : "";
          })();
  if (!readyStr) return null;
  const exact = await findSlotByPlantReadyDate(plantId, subtypeId, readyStr);
  if (exact?.slotId) return { ...exact, created: false };
  return ensureSlotForReadyDate(plantId, subtypeId, readyStr, opts);
}

/**
 * One PlantSlot query for the plant, then exact/nearest match across preferred
 * subtype ids (in order). Much faster than repeated findSlot/findNearest calls.
 * @returns {{ slotId, startDay, endDay, plantReadyDays, plantReadyDate, subtypeId, nearest? } | null}
 */
export async function resolveSowCalendarSlotFast(
  plantId,
  subtypeIds,
  plantReadyDate
) {
  const ready =
    plantReadyDate instanceof Date
      ? plantReadyDate
      : parseLocalDate(plantReadyDate) || parseDdMmYyyy(plantReadyDate);
  const ids = (Array.isArray(subtypeIds) ? subtypeIds : [subtypeIds])
    .map((id) => String(id || "").trim())
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!ready || !plantId || !ids.length) return null;

  const readyStr = fmtDDMMYYYY(ready);
  const readyMs = new Date(ready).setHours(12, 0, 0, 0);

  const docs = await PlantSlot.find({
    plantId: new mongoose.Types.ObjectId(plantId),
  })
    .select("subtypeSlots year")
    .lean();

  const bySubtype = new Map();
  for (const doc of docs || []) {
    for (const st of doc.subtypeSlots || []) {
      const sid = String(st.subtypeId);
      if (!bySubtype.has(sid)) bySubtype.set(sid, []);
      bySubtype.get(sid).push(...(st.slots || []));
    }
  }

  const pickExact = (slots) => {
    for (const slot of slots || []) {
      const start = parseDdMmYyyy(slot.startDay);
      const end = parseDdMmYyyy(slot.endDay) || start;
      if (!start || !end) continue;
      const a = new Date(start).setHours(0, 0, 0, 0);
      const b = new Date(end).setHours(23, 59, 59, 999);
      if (readyMs >= a && readyMs <= b) {
        return {
          slotId: slot._id,
          startDay: slot.startDay,
          endDay: slot.endDay,
          plantReadyDays: Number(slot.plantReadyDays) || 0,
          plantReadyDate: readyStr,
          nearest: false,
        };
      }
    }
    return null;
  };

  const pickNearest = (slots) => {
    let best = null;
    let bestDist = Infinity;
    for (const slot of slots || []) {
      const start = parseDdMmYyyy(slot.startDay);
      const end = parseDdMmYyyy(slot.endDay) || start;
      if (!start) continue;
      const a = new Date(start).setHours(0, 0, 0, 0);
      const b = new Date(end).setHours(23, 59, 59, 999);
      let dist = 0;
      if (readyMs >= a && readyMs <= b) dist = 0;
      else if (readyMs < a) dist = a - readyMs;
      else dist = readyMs - b;
      if (dist < bestDist) {
        bestDist = dist;
        best = {
          slotId: slot._id,
          startDay: slot.startDay,
          endDay: slot.endDay,
          plantReadyDays: Number(slot.plantReadyDays) || 0,
          plantReadyDate: readyStr,
          nearest: dist > 0,
        };
        if (dist === 0) return best;
      }
    }
    return best;
  };

  for (const sid of ids) {
    const slots = bySubtype.get(sid);
    if (!slots?.length) continue;
    const exact = pickExact(slots);
    if (exact) return { ...exact, subtypeId: sid };
  }
  for (const sid of ids) {
    const slots = bySubtype.get(sid);
    if (!slots?.length) continue;
    const near = pickNearest(slots);
    if (near) return { ...near, subtypeId: sid };
  }
  return null;
}
