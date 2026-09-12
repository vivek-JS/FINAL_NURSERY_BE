import mongoose from "mongoose";
import Order from "../models/order.model.js";
import RaisingSeedIntake from "../models/raisingSeedIntake.model.js";
import SowingRequest from "../models/sowingRequest.model.js";

export const ACTIVE_SOWING_ORDER_STATUSES = [
  "PENDING",
  "PROCESSING",
  "ACCEPTED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

const ACTIVE_REQUEST_STATUSES = ["pending", "processing", "issued"];

function idOf(value) {
  return String(value?._id || value || "");
}

export function validateCompanySeedOverrideSelection({
  requestedIds,
  orders,
  intakeOrderIds = [],
  activeRequestOrderIds = [],
  plantId,
  subtypeId,
}) {
  const requested = [...new Set((requestedIds || []).map(String))];
  const byId = new Map((orders || []).map((order) => [idOf(order), order]));
  const intakeSet = new Set(intakeOrderIds.map(String));
  const requestSet = new Set(activeRequestOrderIds.map(String));
  const errors = [];

  for (const orderId of requested) {
    const order = byId.get(orderId);
    if (!order) {
      errors.push({ orderId, reason: "Order not found" });
      continue;
    }
    if (idOf(order.plantName) !== String(plantId) || idOf(order.plantSubtype) !== String(subtypeId)) {
      errors.push({ orderId, reason: "Order plant/subtype does not match" });
    } else if (!ACTIVE_SOWING_ORDER_STATUSES.includes(String(order.orderStatus))) {
      errors.push({ orderId, reason: `Order status ${order.orderStatus} is not eligible` });
    } else if (order.sowingDone) {
      errors.push({ orderId, reason: "Order sowing is already completed" });
    } else if (!["RAISING", "MIXED"].includes(String(order.sowingPlan?.seedSource))) {
      errors.push({ orderId, reason: "Order is not planned for farmer seed" });
    } else if (
      order.sowingPlan?.raisingIntakeCollected ||
      order.sowingPlan?.raisingIntakeId ||
      intakeSet.has(orderId)
    ) {
      errors.push({ orderId, reason: "Farmer seed is already collected or linked" });
    } else if (requestSet.has(orderId)) {
      errors.push({ orderId, reason: "Order is already linked to an active sowing request" });
    }
  }

  return { valid: errors.length === 0, errors, requested };
}

export function buildCompanySeedOverrideUpdate(order, userId, changedAt = new Date()) {
  const oldPlan =
    typeof order.sowingPlan?.toObject === "function"
      ? order.sowingPlan.toObject()
      : { ...(order.sowingPlan || {}) };
  const fallbackNote = "Farmer seed not received; company seed approved for sowing.";
  const oldNotes = String(oldPlan.sowingNotes || "").trim();
  const sowingNotes = oldNotes.includes(fallbackNote)
    ? oldNotes
    : [oldNotes, fallbackNote].filter(Boolean).join(" · ");

  return {
    $set: {
      "sowingPlan.seedSource": "COMPANY",
      "sowingPlan.companySeedPackets": 0,
      "sowingPlan.raisingSeedPackets": 0,
      "sowingPlan.sowingNotes": sowingNotes,
      "sowingPlan.raisingIntakeCollected": false,
    },
    $unset: {
      "sowingPlan.raisingIntakeId": "",
      "sowingPlan.raisingIntake": "",
    },
    $push: {
      orderEditHistory: {
        field: "sowingPlan",
        previousValue: oldPlan,
        newValue: {
          seedSource: "COMPANY",
          companySeedPackets: 0,
          raisingSeedPackets: 0,
          sowingNotes,
          raisingIntakeCollected: false,
        },
        changedBy: userId,
        notes: `Company seed fallback approved at ${changedAt.toISOString()}`,
        createdAt: changedAt,
        updatedAt: changedAt,
      },
    },
  };
}

export async function overrideOrdersWithCompanySeed({
  orderIds,
  plantId,
  subtypeId,
  userId,
}) {
  const requestedIds = [...new Set((orderIds || []).map(String))];
  const objectIds = requestedIds.map((id) => new mongoose.Types.ObjectId(id));
  const session = await mongoose.startSession();
  let converted = [];

  try {
    await session.withTransaction(async () => {
      const orders = await Order.find({ _id: { $in: objectIds } }).session(session);
      const [intakes, activeRequests] = await Promise.all([
        RaisingSeedIntake.find({ orderId: { $in: objectIds } })
          .select("orderId")
          .session(session)
          .lean(),
        SowingRequest.find({
          linkedOrderIds: { $in: objectIds },
          status: { $in: ACTIVE_REQUEST_STATUSES },
        })
          .select("linkedOrderIds")
          .session(session)
          .lean(),
      ]);
      const activeRequestOrderIds = activeRequests.flatMap((request) =>
        (request.linkedOrderIds || [])
          .map(String)
          .filter((id) => requestedIds.includes(id))
      );
      const validation = validateCompanySeedOverrideSelection({
        requestedIds,
        orders,
        intakeOrderIds: intakes.map((intake) => String(intake.orderId)),
        activeRequestOrderIds,
        plantId,
        subtypeId,
      });
      if (!validation.valid) {
        const error = new Error("Some orders cannot be switched to company seed");
        error.statusCode = 409;
        error.details = validation.errors;
        throw error;
      }

      const changedAt = new Date();
      for (const order of orders) {
        await Order.updateOne(
          { _id: order._id },
          buildCompanySeedOverrideUpdate(order, userId, changedAt),
          { session, runValidators: true }
        );
      }
      converted = orders.map((order) => ({
        orderId: String(order._id),
        orderNumber: order.orderId,
        seedSource: "COMPANY",
      }));
    });
    return converted;
  } finally {
    await session.endSession();
  }
}
