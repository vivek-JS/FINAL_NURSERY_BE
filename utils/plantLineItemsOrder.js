import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";

/**
 * Parse plantLineItems from JSON body or FormData string.
 * @returns {object[]|null} normalized raw array, or null if absent/empty
 */
export function parsePlantLineItemsInput(raw) {
  if (raw == null || raw === "" || raw === "null" || raw === "undefined") {
    return null;
  }
  let arr = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw.trim());
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr;
}

function asObjectId(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object" && value._id) value = value._id;
  const s = String(value);
  if (!mongoose.isValidObjectId(s)) return null;
  return s;
}

/**
 * Validate and normalize plant line items for order create.
 * @returns {{ lines: object[], totalPlants: number, error?: string }}
 */
export function normalizePlantLineItemsForCreate(rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    return { lines: [], totalPlants: 0, error: "plantLineItems must be a non-empty array" };
  }

  const lines = [];
  let totalPlants = 0;

  for (let i = 0; i < rawLines.length; i += 1) {
    const row = rawLines[i] || {};
    const plantName = asObjectId(row.plantName);
    const plantSubtype = asObjectId(row.plantSubtype);
    const bookingSlot = asObjectId(row.bookingSlot);
    const numberOfPlants = Number(row.numberOfPlants);
    const rate = Number(row.rate);
    const cavity = asObjectId(row.cavity);

    if (!plantName || !plantSubtype || !bookingSlot) {
      return {
        lines: [],
        totalPlants: 0,
        error: `plantLineItems[${i}]: plantName, plantSubtype, and bookingSlot are required`,
      };
    }
    if (!Number.isFinite(numberOfPlants) || numberOfPlants < 1) {
      return {
        lines: [],
        totalPlants: 0,
        error: `plantLineItems[${i}]: numberOfPlants must be >= 1`,
      };
    }
    if (!Number.isFinite(rate) || rate < 0) {
      return {
        lines: [],
        totalPlants: 0,
        error: `plantLineItems[${i}]: rate must be a non-negative number`,
      };
    }

    let deliveryDate;
    if (row.deliveryDate != null && row.deliveryDate !== "") {
      const d = new Date(row.deliveryDate);
      if (!Number.isNaN(d.getTime())) deliveryDate = d;
    }

    const plantNameSnapshot =
      typeof row.plantNameSnapshot === "string"
        ? row.plantNameSnapshot.trim()
        : typeof row.plantName === "object" && row.plantName?.name
          ? String(row.plantName.name).trim()
          : "";
    const plantSubtypeSnapshot =
      typeof row.plantSubtypeSnapshot === "string"
        ? row.plantSubtypeSnapshot.trim()
        : typeof row.plantSubtype === "object" &&
            (row.plantSubtype?.name || row.plantSubtype?.subtypeName)
          ? String(row.plantSubtype.name || row.plantSubtype.subtypeName).trim()
          : "";

    totalPlants += numberOfPlants;
    lines.push({
      plantName,
      plantSubtype,
      plantNameSnapshot,
      plantSubtypeSnapshot,
      bookingSlot,
      numberOfPlants,
      rate,
      ...(cavity ? { cavity } : {}),
      ...(deliveryDate ? { deliveryDate } : {}),
      sortOrder: Number.isFinite(Number(row.sortOrder)) ? Number(row.sortOrder) : i,
      quotaUsed: 0,
      quotaSource: "none",
    });
  }

  return { lines, totalPlants };
}

/** Fill missing plant/subtype name snapshots from PlantCms (for invoice/list). */
export async function enrichPlantLineSnapshots(lines, session) {
  if (!Array.isArray(lines) || lines.length === 0) return lines;
  const needIds = [
    ...new Set(
      lines
        .filter((l) => !l.plantNameSnapshot || !l.plantSubtypeSnapshot)
        .map((l) => String(l.plantName))
    ),
  ];
  if (needIds.length === 0) return lines;

  const plants = await PlantCms.find({ _id: { $in: needIds } })
    .select("name subtypes")
    .session(session || undefined)
    .lean();
  const byId = new Map(plants.map((p) => [String(p._id), p]));

  for (const line of lines) {
    const plant = byId.get(String(line.plantName));
    if (!plant) continue;
    if (!line.plantNameSnapshot) line.plantNameSnapshot = plant.name || "";
    if (!line.plantSubtypeSnapshot && Array.isArray(plant.subtypes)) {
      const st = plant.subtypes.find(
        (s) => String(s._id) === String(line.plantSubtype)
      );
      line.plantSubtypeSnapshot = st?.name || "";
    }
  }
  return lines;
}

/** Apply first-line + sum rollup onto a plain orderData object (pre-save). */
export function applyPlantLineRollupToOrderData(orderData, lines, totalPlants) {
  if (!lines?.length) return orderData;
  const first = lines[0];
  orderData.plantName = first.plantName;
  orderData.plantSubtype = first.plantSubtype;
  orderData.bookingSlot = first.bookingSlot;
  orderData.rate = first.rate;
  orderData.numberOfPlants = totalPlants;
  orderData.plantLineItems = lines;
  if (first.cavity) orderData.cavity = first.cavity;
  if (first.deliveryDate) orderData.deliveryDate = first.deliveryDate;
  return orderData;
}
