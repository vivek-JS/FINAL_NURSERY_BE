import mongoose from "mongoose";
import ReadyDispatchGroup from "../models/readyDispatchGroup.model.js";
import Order from "../models/order.model.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";

const ACTIVE_GROUP_STATUSES = ["DRAFT", "LOCKED"];

const getOrderPlantCount = (order) =>
  Number(order?.totalPlants || order?.numberOfPlants || 0);

const buildGroupCode = () =>
  `RDG-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;

const normalizeId = (id) => String(id);

const toObjectIdArray = (ids = []) =>
  ids
    .map((id) => {
      try {
        return new mongoose.Types.ObjectId(id);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const ensureOrdersAreReadyForDispatch = async (orderIds) => {
  const uniqueIds = [...new Set(orderIds.map(normalizeId))];
  if (!uniqueIds.length) {
    throw new AppError("At least one order is required for grouping", 400);
  }

  const objectIds = toObjectIdArray(uniqueIds);
  if (objectIds.length !== uniqueIds.length) {
    throw new AppError("One or more order ids are invalid", 400);
  }

  const orders = await Order.find({
    _id: { $in: objectIds },
    orderStatus: "READY_FOR_DISPATCH",
  }).select("_id orderId totalPlants numberOfPlants dispatchDayKey dispatchTargetDate");

  if (orders.length !== uniqueIds.length) {
    throw new AppError(
      "Only READY_FOR_DISPATCH orders can be grouped. Some selected orders are invalid.",
      400
    );
  }

  return orders;
};

const assertNoOrderAlreadyGrouped = async (orderIds, excludeGroupId = null) => {
  const q = {
    orderIds: { $in: toObjectIdArray(orderIds) },
    status: { $in: ACTIVE_GROUP_STATUSES },
  };
  if (excludeGroupId) {
    q._id = { $ne: excludeGroupId };
  }
  const existing = await ReadyDispatchGroup.findOne(q).select("_id groupCode");
  if (existing) {
    throw new AppError(
      `One or more orders already exist in active group ${existing.groupCode}`,
      409
    );
  }
};

export const suggestReadyDispatchGroups = catchAsync(async (req, res, next) => {
  const { orderIds = [], capacityMeta = {} } = req.body || {};
  const maxCapacity = Number(capacityMeta?.max);

  if (!Number.isFinite(maxCapacity) || maxCapacity <= 0) {
    return next(new AppError("capacityMeta.max must be a positive number", 400));
  }

  const ids = Array.isArray(orderIds) ? orderIds : [];
  let orders = [];

  if (ids.length > 0) {
    orders = await ensureOrdersAreReadyForDispatch(ids);
  } else {
    orders = await Order.find({ orderStatus: "READY_FOR_DISPATCH" }).select(
      "_id orderId totalPlants numberOfPlants dispatchDayKey dispatchTargetDate"
    );
  }

  // Greedy capacity packing; sorted by target date then size.
  const sorted = [...orders].sort((a, b) => {
    const ad = a?.dispatchTargetDate ? new Date(a.dispatchTargetDate).getTime() : Number.MAX_SAFE_INTEGER;
    const bd = b?.dispatchTargetDate ? new Date(b.dispatchTargetDate).getTime() : Number.MAX_SAFE_INTEGER;
    if (ad !== bd) return ad - bd;
    return getOrderPlantCount(b) - getOrderPlantCount(a);
  });

  const groups = [];
  let current = null;

  for (const order of sorted) {
    const qty = getOrderPlantCount(order);
    if (!current || current.totalPlants + qty > maxCapacity) {
      current = {
        tempId: `tmp-${groups.length + 1}`,
        capacityMeta: {
          type: capacityMeta?.type || "PLANTS",
          unit: capacityMeta?.unit || "plants",
          max: maxCapacity,
        },
        orderIds: [],
        orders: [],
        totalPlants: 0,
      };
      groups.push(current);
    }
    current.orderIds.push(order._id);
    current.orders.push({
      _id: order._id,
      orderId: order.orderId,
      totalPlants: qty,
      dispatchDayKey: order.dispatchDayKey || null,
      dispatchTargetDate: order.dispatchTargetDate || null,
    });
    current.totalPlants += qty;
  }

  return res.status(200).json(
    generateResponse("Success", "Ready dispatch grouping suggestion generated", {
      groups,
      meta: {
        totalOrders: sorted.length,
        totalGroups: groups.length,
        capacityMeta: {
          type: capacityMeta?.type || "PLANTS",
          unit: capacityMeta?.unit || "plants",
          max: maxCapacity,
        },
      },
    })
  );
});

export const createReadyDispatchGroups = catchAsync(async (req, res, next) => {
  const { groups = [] } = req.body || {};
  if (!Array.isArray(groups) || groups.length === 0) {
    return next(new AppError("groups must be a non-empty array", 400));
  }

  const created = [];
  for (const rawGroup of groups) {
    const orderIds = Array.isArray(rawGroup?.orderIds) ? rawGroup.orderIds : [];
    const orders = await ensureOrdersAreReadyForDispatch(orderIds);
    await assertNoOrderAlreadyGrouped(orderIds);

    const totalPlants = orders.reduce((sum, o) => sum + getOrderPlantCount(o), 0);
    const doc = await ReadyDispatchGroup.create({
      groupCode: buildGroupCode(),
      status: "DRAFT",
      orderIds: orders.map((o) => o._id),
      totalPlants,
      capacityMeta: rawGroup?.capacityMeta || {},
      vehicleRef: rawGroup?.vehicleRef || "",
      driverRef: rawGroup?.driverRef || null,
      dispatchDayKey: rawGroup?.dispatchDayKey || null,
      dispatchTargetDate: rawGroup?.dispatchTargetDate || null,
      notes: rawGroup?.notes || "",
      createdBy: req.user?._id || null,
    });
    created.push(doc);
  }

  return res.status(201).json(
    generateResponse("Success", "Ready dispatch groups created successfully", created)
  );
});

export const getReadyDispatchGroups = catchAsync(async (req, res) => {
  const { status } = req.query;
  const filter = {};
  if (status) filter.status = status;

  const groups = await ReadyDispatchGroup.find(filter)
    .populate({
      path: "orderIds",
      select:
        "orderId numberOfPlants totalPlants orderStatus dispatchDayKey dispatchTargetDate deliveryDate farmer",
      populate: { path: "farmer", select: "name village mobileNumber" },
    })
    .sort({ createdAt: -1 });

  return res
    .status(200)
    .json(generateResponse("Success", "Ready dispatch groups fetched successfully", groups));
});

export const updateReadyDispatchGroup = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid group id", 400));
  }

  const existing = await ReadyDispatchGroup.findById(id);
  if (!existing) {
    return next(new AppError("Ready dispatch group not found", 404));
  }

  const payload = { ...req.body };
  if (payload.orderIds) {
    const orderIds = Array.isArray(payload.orderIds) ? payload.orderIds : [];
    await ensureOrdersAreReadyForDispatch(orderIds);
    await assertNoOrderAlreadyGrouped(orderIds, existing._id);

    const orders = await Order.find({ _id: { $in: toObjectIdArray(orderIds) } }).select(
      "_id totalPlants numberOfPlants"
    );
    payload.totalPlants = orders.reduce((sum, o) => sum + getOrderPlantCount(o), 0);
  }

  const updated = await ReadyDispatchGroup.findByIdAndUpdate(id, payload, {
    new: true,
    runValidators: true,
  });

  return res
    .status(200)
    .json(generateResponse("Success", "Ready dispatch group updated successfully", updated));
});

export const convertReadyDispatchGroupToDispatch = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid group id", 400));
  }

  const group = await ReadyDispatchGroup.findById(id).populate({
    path: "orderIds",
    select:
      "_id orderId numberOfPlants totalPlants orderStatus dispatchDayKey dispatchTargetDate plantName plantSubtype farmer deliveryDate cavity",
  });
  if (!group) {
    return next(new AppError("Ready dispatch group not found", 404));
  }

  if (group.status === "CANCELLED") {
    return next(new AppError("Cancelled groups cannot be converted", 400));
  }

  group.status = "LOCKED";
  await group.save();

  return res.status(200).json(
    generateResponse("Success", "Group locked for dispatch handoff", {
      group,
      dispatchPrefill: {
        orderIds: group.orderIds.map((o) => o._id),
      },
    })
  );
});
