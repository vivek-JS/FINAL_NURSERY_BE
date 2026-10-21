import catchAsync from "../utility/catchAsync.js";
import { listSowBatchStock, getSowBatchStockDetail } from "../services/sowBatchStock.service.js";
import { sowBatchStockIntel } from "../services/sowBatchStock.intel.js";

/** GET /sowing/sow-batch-stock — sowingAllowed plant batches + remaining stock. */
export const getSowBatchStock = catchAsync(async (req, res) => {
  const data = await listSowBatchStock(req.query || {});
  return res.status(200).json({ success: true, ...data });
});

/** GET /sowing/sow-batch-stock/intel — delivery window vs sowed/excess. */
export const getSowBatchStockIntel = catchAsync(async (req, res) => {
  const data = await sowBatchStockIntel(req.query || {});
  if (data?.error) {
    return res.status(400).json({ success: false, message: data.error });
  }
  return res.status(200).json({ success: true, ...data });
});

/** GET /sowing/sow-batch-stock/:batchId — batch + unified stock-change timeline. */
export const getSowBatchStockById = catchAsync(async (req, res) => {
  if (String(req.params.batchId || "").toLowerCase() === "intel") {
    return getSowBatchStockIntel(req, res);
  }
  const data = await getSowBatchStockDetail(req.params.batchId);
  if (!data) {
    return res.status(404).json({ success: false, message: "Sowing batch not found" });
  }
  return res.status(200).json({ success: true, item: data });
});
