import { fetchMisMobile } from "../services/misMobile.service.js";
import { createShortTtlCache } from "../utility/shortTtlCache.js";

const misCache = createShortTtlCache(30_000);

/**
 * GET /api/v1/order/mis-mobile?startDate&endDate&days=5
 * Per variety: booked + out (dispatched) in the range, and open plants due on each of the next `days` days.
 */
export const getMisMobile = async (req, res) => {
  try {
    const { startDate, endDate, days } = req.query || {};
    const force =
      String(req.headers["x-cache-bust"] || "") === "1" ||
      String(req.headers["x-sowing-cache-bust"] || "") === "1";
    const key = `${startDate || ""}|${endDate || ""}|${days || ""}`;
    if (!force) {
      const hit = misCache.get(key);
      if (hit) {
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json({ success: true, ...hit, cached: true });
      }
    }
    const result = await fetchMisMobile({ startDate, endDate, days });
    if (result.error) {
      return res.status(result.statusCode || 400).json({ success: false, message: result.error });
    }
    misCache.set(key, result.data);
    res.setHeader("Cache-Control", "private, max-age=15");
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json({ success: true, ...result.data, cached: false });
  } catch (error) {
    console.error("[mis-mobile]", error);
    return res.status(500).json({ success: false, message: error.message || "Could not load MIS" });
  }
};
