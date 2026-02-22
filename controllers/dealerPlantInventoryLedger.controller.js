import catchAsync from "../utility/catchAsync.js";
import DealerPlantInventoryLedger from "../models/dealerPlantInventoryLedger.model.js";
import mongoose from "mongoose";

/**
 * Get dealer plant inventory ledger with pagination and filters
 * GET /user/dealers/:dealerId/plant-ledger
 */
export const getDealerPlantLedger = catchAsync(async (req, res) => {
  const { dealerId } = req.params;
  const { page = 1, limit = 20, type, plantType, startDate, endDate } = req.query;

  if (!dealerId) {
    return res.status(400).json({
      success: false,
      message: "Dealer ID is required",
    });
  }

  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
  const skip = (pageNum - 1) * limitNum;

  const match = { dealer: new mongoose.Types.ObjectId(dealerId) };

  if (type && ["INVENTORY_ADD", "INVENTORY_BOOK", "INVENTORY_RELEASE"].includes(type.toUpperCase())) {
    match.transactionType = type.toUpperCase();
  }

  if (plantType && mongoose.Types.ObjectId.isValid(plantType)) {
    match.plantType = new mongoose.Types.ObjectId(plantType);
  }

  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }

  const [entries, total] = await Promise.all([
    DealerPlantInventoryLedger.find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("plantType", "name")
      .populate("performedBy", "name")
      .populate("referenceId", "orderId")
      .lean(),
    DealerPlantInventoryLedger.countDocuments(match),
  ]);

  const totalPages = Math.ceil(total / limitNum);

  return res.status(200).json({
    success: true,
    message: "Plant inventory ledger fetched successfully",
    data: {
      entries,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages,
      },
    },
  });
});
