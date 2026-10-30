import mongoose from "mongoose";
import { getDispatchLagwad } from "../services/dispatchLagwad.service.js";
import { loadCropOptions } from "../services/dispatchLagwadSources.js";
import { getActualStock } from "../services/actualStock.service.js";
import { istDay, parseWindowDays } from "../utility/dispatchLagwadBuckets.js";
import { createShortTtlCache } from "../utility/shortTtlCache.js";

const cache = createShortTtlCache(60_000);

export const getDispatchActualStock = async (req, res) => {
  try {
    const { plantId, subtypeId } = req.query || {};
    if (!mongoose.isValidObjectId(String(plantId || "")) || (subtypeId && !mongoose.isValidObjectId(String(subtypeId)))) {
      return res.status(400).json({ success: false, message: "Valid plantId is required" });
    }
    const stock = await getActualStock({ plantId, subtypeId: subtypeId || null });
    return res.status(200).json({ success: true, stock });
  } catch (error) {
    console.error("getDispatchActualStock error:", error);
    return res.status(500).json({ success: false, message: "Failed to load actual stock" });
  }
};

export const getDispatchLagwadCrops = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, crops: await loadCropOptions() });
  } catch (error) {
    console.error("getDispatchLagwadCrops error:", error);
    return res.status(500).json({ success: false, message: "Failed to load crops" });
  }
};
const MAX_RANGE_DAYS = 120;

export const getDispatchLagwadBoard = async (req, res) => {
  try {
    const { plantId, subtypeId, from, to } = req.query || {};
    if (!mongoose.isValidObjectId(String(plantId || ""))) {
      return res.status(400).json({ success: false, message: "Valid plantId is required" });
    }
    if (subtypeId && !mongoose.isValidObjectId(String(subtypeId))) {
      return res.status(400).json({ success: false, message: "Invalid subtypeId" });
    }
    const start = istDay(from);
    const end = istDay(to);
    if (!start || !end || end.isBefore(start)) {
      return res.status(400).json({ success: false, message: "from/to must be YYYY-MM-DD and from <= to" });
    }
    if (end.diff(start, "days") > MAX_RANGE_DAYS) {
      return res.status(400).json({ success: false, message: `Range is limited to ${MAX_RANGE_DAYS} days` });
    }
    const windowDays = parseWindowDays(req.query.windowDays);
    const key = [plantId, subtypeId || "", from, to, windowDays].join("|");
    const hit = req.query._t ? null : cache.get(key);
    if (hit) return res.status(200).json({ success: true, ...hit, cached: true });

    const body = await getDispatchLagwad({ plantId, subtypeId: subtypeId || null, from, to, windowDays });
    cache.set(key, body);
    return res.status(200).json({ success: true, ...body });
  } catch (error) {
    console.error("getDispatchLagwadBoard error:", error);
    return res.status(500).json({ success: false, message: "Failed to load dispatch & lagwad" });
  }
};
