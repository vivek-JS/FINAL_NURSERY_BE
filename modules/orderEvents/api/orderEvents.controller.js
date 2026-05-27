import mongoose from "mongoose";
import catchAsync from "../../../utility/catchAsync.js";
import generateResponse from "../../../utility/responseFormat.js";
import AppError from "../../../utility/appError.js";
import OrderEvent from "../models/orderEvent.model.js";
import { ORDER_DOMAINS } from "../domain/constants.js";

function parseLimit(raw, fallback = 100) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 500);
}

async function queryOrderTimeline({ orderDomain, orderId, limit, cursor }) {
  if (!mongoose.isValidObjectId(orderId)) {
    throw new AppError("Valid orderId is required", 400);
  }

  const filter = {
    orderDomain,
    orderId: new mongoose.Types.ObjectId(orderId),
  };

  if (cursor) {
    if (!mongoose.isValidObjectId(cursor)) {
      throw new AppError("Invalid cursor", 400);
    }
    const cursorDoc = await OrderEvent.findById(cursor).select("occurredAt _id").lean();
    if (cursorDoc) {
      filter.$or = [
        { occurredAt: { $lt: cursorDoc.occurredAt } },
        { occurredAt: cursorDoc.occurredAt, _id: { $lt: cursorDoc._id } },
      ];
    }
  }

  const events = await OrderEvent.find(filter)
    .sort({ occurredAt: -1, _id: -1 })
    .limit(limit + 1)
    .populate("actorId", "name phoneNumber")
    .lean();

  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(0, limit) : events;
  const nextCursor = hasMore ? String(page[page.length - 1]._id) : null;

  const normalized = page.map((e) => ({
    _id: e._id,
    eventType: e.eventType,
    field: e.field,
    previousValue: e.previousValue,
    newValue: e.newValue,
    description: e.description,
    occurredAt: e.occurredAt,
    actorId: e.actorId?._id || e.actorId,
    actorName:
      e.actorName ||
      (typeof e.actorId === "object" && e.actorId?.name ? e.actorId.name : undefined),
    reason: e.reason,
    approval: e.approval,
    refs: e.refs,
    correlationId: e.correlationId,
    metadata: e.metadata,
    source: e.source,
  }));

  return { events: normalized, nextCursor };
}

export const listOrderEvents = catchAsync(async (req, res) => {
  const { orderDomain, orderId } = req.query;
  if (!orderDomain || !orderId) {
    throw new AppError("orderDomain and orderId query params are required", 400);
  }
  if (!Object.values(ORDER_DOMAINS).includes(orderDomain)) {
    throw new AppError("Invalid orderDomain", 400);
  }
  const limit = parseLimit(req.query.limit);
  const { events, nextCursor } = await queryOrderTimeline({
    orderDomain,
    orderId,
    limit,
    cursor: req.query.cursor,
  });
  return res.status(200).json(
    generateResponse("Success", "Order events", { events, nextCursor }, undefined)
  );
});

export const getPlantOrderTimeline = catchAsync(async (req, res) => {
  const { orderId } = req.params;
  const limit = parseLimit(req.query.limit);
  const { events, nextCursor } = await queryOrderTimeline({
    orderDomain: ORDER_DOMAINS.PLANT,
    orderId,
    limit,
    cursor: req.query.cursor,
  });
  return res.status(200).json(
    generateResponse("Success", "Order timeline", { events, nextCursor }, undefined)
  );
});

export const getAgriOrderTimeline = catchAsync(async (req, res) => {
  const { id } = req.params;
  const limit = parseLimit(req.query.limit);
  const { events, nextCursor } = await queryOrderTimeline({
    orderDomain: ORDER_DOMAINS.AGRI,
    orderId: id,
    limit,
    cursor: req.query.cursor,
  });
  return res.status(200).json(
    generateResponse("Success", "Agri order timeline", { events, nextCursor }, undefined)
  );
});
