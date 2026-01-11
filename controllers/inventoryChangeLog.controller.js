import mongoose from 'mongoose';
import InventoryChangeLog from '../models/inventoryChangeLog.model.js';
import catchAsync from '../utility/catchAsync.js';
import AppError from '../utility/appError.js';
import generateResponse from '../utility/responseFormat.js';

// Get change logs for a specific entity
export const getChangeLogsByEntity = catchAsync(async (req, res, next) => {
  const { entityType, entityId } = req.params;
  const { page = 1, limit = 50, action } = req.query;

  if (!entityType || !entityId) {
    return next(new AppError('Entity type and entity ID are required', 400));
  }

  if (!mongoose.isValidObjectId(entityId)) {
    return next(new AppError('Invalid entity ID format', 400));
  }

  const query = {
    entityType,
    entityId: new mongoose.Types.ObjectId(entityId),
  };

  if (action) {
    query.action = action;
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [changeLogs, total] = await Promise.all([
    InventoryChangeLog.find(query)
      .populate('changedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    InventoryChangeLog.countDocuments(query),
  ]);

  const response = generateResponse(
    'Success',
    'Change logs fetched successfully',
    {
      changeLogs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// Get all change logs with filters
export const getAllChangeLogs = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 50,
    entityType,
    action,
    changedBy,
    startDate,
    endDate,
  } = req.query;

  const query = {};

  if (entityType) {
    query.entityType = entityType;
  }

  if (action) {
    query.action = action;
  }

  if (changedBy) {
    if (!mongoose.isValidObjectId(changedBy)) {
      return next(new AppError('Invalid changedBy ID format', 400));
    }
    query.changedBy = new mongoose.Types.ObjectId(changedBy);
  }

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) {
      query.createdAt.$gte = new Date(startDate);
    }
    if (endDate) {
      query.createdAt.$lte = new Date(endDate);
    }
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [changeLogs, total] = await Promise.all([
    InventoryChangeLog.find(query)
      .populate('changedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    InventoryChangeLog.countDocuments(query),
  ]);

  const response = generateResponse(
    'Success',
    'Change logs fetched successfully',
    {
      changeLogs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// Get change log statistics
export const getChangeLogStats = catchAsync(async (req, res, next) => {
  const { entityType, startDate, endDate } = req.query;

  const query = {};

  if (entityType) {
    query.entityType = entityType;
  }

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) {
      query.createdAt.$gte = new Date(startDate);
    }
    if (endDate) {
      query.createdAt.$lte = new Date(endDate);
    }
  }

  const stats = await InventoryChangeLog.aggregate([
    { $match: query },
    {
      $group: {
        _id: {
          entityType: '$entityType',
          action: '$action',
        },
        count: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: '$_id.entityType',
        actions: {
          $push: {
            action: '$_id.action',
            count: '$count',
          },
        },
        total: { $sum: '$count' },
      },
    },
    { $sort: { total: -1 } },
  ]);

  const response = generateResponse(
    'Success',
    'Change log statistics fetched successfully',
    stats,
    undefined
  );

  return res.status(200).json(response);
});

