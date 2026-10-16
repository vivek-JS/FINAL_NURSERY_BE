import { fetchMisMobile } from "../services/misMobile.service.js";

/**
 * GET /api/v1/order/mis-mobile?startDate&endDate&days=5
 * Per variety: booked + out (dispatched) in the range, and open plants due on each of the next `days` days.
 */
export const getMisMobile = async (req, res) => {
  try {
    const { startDate, endDate, days } = req.query || {};
    const result = await fetchMisMobile({ startDate, endDate, days });
    if (result.error) {
      return res.status(result.statusCode || 400).json({ success: false, message: result.error });
    }
    return res.status(200).json({ success: true, ...result.data });
  } catch (error) {
    console.error("[mis-mobile]", error);
    return res.status(500).json({ success: false, message: error.message || "Could not load MIS" });
  }
};
