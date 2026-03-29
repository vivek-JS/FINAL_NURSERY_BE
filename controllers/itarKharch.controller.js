import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import ItarKharchEntry from "../models/itarKharchEntry.model.js";
import mongoose from "mongoose";

export const createBulkItarKharch = catchAsync(async (req, res, next) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (!entries.length) {
    return next(new AppError("At least one expense entry is required", 400));
  }

  const docs = entries.map((entry) => {
    const amount = Number(entry?.amount || 0);
    return {
      category: String(entry?.category || "").trim(),
      amount,
      note: String(entry?.note || "").trim(),
      entryDate: entry?.entryDate ? new Date(entry.entryDate) : new Date(),
      createdBy: req.user?._id || req.user?.id,
    };
  });

  const invalid = docs.find((d) => !d.category || !Number.isFinite(d.amount) || d.amount <= 0);
  if (invalid) {
    return next(new AppError("Each entry needs valid category and amount", 400));
  }

  const created = await ItarKharchEntry.insertMany(docs);
  const totalAmount = created.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

  return res.status(201).json(
    generateResponse("Success", "Itar kharch entries created", {
      count: created.length,
      totalAmount,
      data: created,
    })
  );
});

export const getItarKharchEntries = catchAsync(async (req, res) => {
  const { page = 1, limit = 50, category, startDate, endDate, mine, createdBy } = req.query;
  const limitNum = Math.min(200, Math.max(1, Number(limit) || 50));
  const pageNum = Math.max(1, Number(page) || 1);
  const skip = (pageNum - 1) * limitNum;
  const filter = {};
  const requesterId = req.user?._id || req.user?.id;
  const requesterRole = req.user?.role || req.user?.jobTitle;

  if (category) {
    filter.category = String(category).trim();
  }
  if (startDate && endDate) {
    const from = new Date(startDate);
    const to = new Date(endDate);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      filter.entryDate = { $gte: from, $lte: to };
    }
  }
  if (mine === "true" && requesterId) {
    filter.createdBy = new mongoose.Types.ObjectId(requesterId);
  }
  if (createdBy) {
    if (!mongoose.Types.ObjectId.isValid(createdBy)) {
      throw new AppError("Invalid createdBy", 400);
    }
    const createdById = new mongoose.Types.ObjectId(createdBy);
    if (requesterRole === "CASHIER" && requesterId && String(createdById) !== String(requesterId)) {
      throw new AppError("CASHIER can only access own entries", 403);
    }
    filter.createdBy = createdById;
  }

  const [data, total, totals] = await Promise.all([
    ItarKharchEntry.find(filter)
      .sort({ entryDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("createdBy", "name phoneNumber role jobTitle")
      .lean(),
    ItarKharchEntry.countDocuments(filter),
    ItarKharchEntry.aggregate([
      { $match: filter },
      { $group: { _id: null, totalAmountSum: { $sum: "$amount" } } },
    ]),
  ]);

  return res.status(200).json(
    generateResponse("Success", "Itar kharch entries fetched", {
      data,
      total,
      page: pageNum,
      limit: limitNum,
      totalAmountSum: totals?.[0]?.totalAmountSum || 0,
    })
  );
});
