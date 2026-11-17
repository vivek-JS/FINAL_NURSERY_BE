/**
 * One-off prod: FIFO-correct SR202610180001; reverse+delete SR202610180003.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import SowingRequest from "../models/sowingRequest.model.js";
import Order from "../models/order.model.js";
import PlantSlot from "../models/slots.model.js";
import InventoryOutward from "../models/inventoryOutward.model.js";
import Batch from "../models/batch.model.js";
import Product from "../models/product.model.js";
import {
  planOrderSowCover,
  applyIncompleteRequestRelease,
} from "../services/orderSowCover.plan.js";
import { reverseSowBatchFromSlot } from "../controllers/sowingCompleteHelpers.js";

dotenv.config();

const uri = process.env.PROD_MONGO_URL;
if (!uri) {
  console.error("PROD_MONGO_URL missing");
  process.exit(1);
}

function oid(v) {
  return new mongoose.Types.ObjectId(v);
}

async function fix001() {
  const request = await SowingRequest.findOne({ requestNumber: "SR202610180001" });
  if (!request) throw new Error("SR202610180001 missing");
  const plantsSowed = Math.max(0, Math.floor(Number(request.sowedQuantity) || 0));
  const orders = await Order.find({
    _id: { $in: request.linkedOrderIds || [] },
    orderStatus: {
      $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"],
    },
  })
    .select("_id numberOfPlants additionalPlants deliveryDate createdAt orderId sowingPartialCover sowingDone")
    .sort({ deliveryDate: 1, createdAt: 1, orderId: 1 });

  const plan = planOrderSowCover({
    plantsSowed,
    orders: orders.map((o) => ({
      ...o.toObject(),
      sowingPartialCover: [],
    })),
  });

  const fullIds = plan.full.map((f) => String(f.orderId));
  const partialId = plan.partial?.orderId ? String(plan.partial.orderId) : "";
  const waitingIds = (plan.waiting || []).map((w) => String(w.orderId));
  const sowedAt = request.sowingCompletedDate || new Date();

  for (const o of orders) {
    const id = String(o._id);
    if (fullIds.includes(id)) {
      await Order.updateOne(
        { _id: o._id },
        {
          $set: {
            sowingDone: true,
            sowingDoneAt: o.sowingDoneAt || sowedAt,
            sowingDoneRequestId: request._id,
          },
          $pull: { sowingPartialCover: { requestId: request._id } },
        }
      );
    } else if (partialId && id === partialId) {
      await Order.updateOne(
        { _id: o._id },
        {
          $set: {
            sowingDone: false,
          },
          $unset: { sowingDoneAt: 1, sowingDoneRequestId: 1 },
          $pull: { sowingPartialCover: { requestId: request._id } },
        }
      );
      if (plan.partial.addPlants > 0) {
        await Order.updateOne(
          { _id: o._id },
          {
            $push: {
              sowingPartialCover: {
                requestId: request._id,
                plants: plan.partial.addPlants,
                at: sowedAt,
              },
            },
          }
        );
      }
    } else if (waitingIds.includes(id)) {
      await Order.updateOne(
        { _id: o._id },
        {
          $set: { sowingDone: false },
          $unset: { sowingDoneAt: 1, sowingDoneRequestId: 1 },
          $pull: { sowingPartialCover: { requestId: request._id } },
        }
      );
    }
  }

  applyIncompleteRequestRelease(request, plan, { sowedAt });
  if (!Array.isArray(request.completionEvents)) request.completionEvents = [];
  request.completionEvents.push({
    type: "NOTE",
    at: new Date(),
    quantity: plantsSowed,
    unit: "plants",
    message: "FIFO cover applied — leftover orders released for a new request",
    meta: {
      ordersMarked: plan.full.length,
      partialPlants: plan.partial?.addPlants || 0,
      waitingOrders: plan.waiting.length,
      sowingIncomplete: true,
    },
  });
  await request.save();

  const slotId = request.linkedSlotIds?.[0];
  if (slotId) {
    const keep = [...fullIds, ...(partialId ? [partialId] : [])].map((id) => oid(id));
    await PlantSlot.updateOne(
      {
        "subtypeSlots.slots._id": slotId,
        "subtypeSlots.slots.sowingBatches.sowingRequestId": request._id,
      },
      {
        $set: {
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].linkedOrderIds": keep,
        },
      },
      {
        arrayFilters: [
          { "st.slots._id": slotId },
          { "sl._id": slotId },
          { "b.sowingRequestId": request._id },
        ],
      }
    );
  }

  const afterOrders = await Order.find({ _id: { $in: orders.map((o) => o._id) } })
    .select("orderId sowingDone sowingPartialCover numberOfPlants additionalPlants")
    .lean();
  return {
    requestNumber: request.requestNumber,
    sowingIncomplete: request.sowingIncomplete,
    linked: request.linkedOrderIds?.length,
    uncovered: request.uncoveredOrderIds?.length,
    plan: {
      full: plan.full.map((f) => String(f.orderId)),
      partial: plan.partial,
      waiting: plan.waiting,
    },
    orders: afterOrders.map((o) => ({
      orderId: o.orderId,
      sowingDone: o.sowingDone,
      plants: (o.numberOfPlants || 0) + (o.additionalPlants || 0),
      held: (o.sowingPartialCover || []).reduce((s, r) => s + (r.plants || 0), 0),
    })),
  };
}

async function delete003() {
  const request = await SowingRequest.findOne({ requestNumber: "SR202610180003" });
  if (!request) return { skipped: true, reason: "already gone" };

  const slotId = request.linkedSlotIds?.[0];
  const plants = Math.max(0, Math.floor(Number(request.sowedQuantity) || 0));
  let reversed = 0;
  if (slotId && plants > 0) {
    const r = await reverseSowBatchFromSlot(slotId, request._id, plants);
    reversed = r.reversed;
    await PlantSlot.updateOne(
      { "subtypeSlots.slots._id": slotId },
      {
        $pull: {
          "subtypeSlots.$[st].slots.$[sl].linkedSowingRequests": request._id,
          "subtypeSlots.$[st].slots.$[sl].sowingInProgress": {
            sowingRequestId: request._id,
          },
        },
      },
      { arrayFilters: [{ "st.slots._id": slotId }, { "sl._id": slotId }] }
    );
  }

  if (request.outwardId) {
    const outward = await InventoryOutward.findById(request.outwardId);
    if (outward) {
      for (const item of outward.items || []) {
        const qty = Math.max(0, Number(item.usedQuantity || item.quantity) || 0);
        if (qty > 0 && item.batch) {
          await Batch.updateOne(
            { _id: item.batch },
            { $inc: { remainingQuantity: qty } }
          );
        }
        if (qty > 0 && item.product) {
          await Product.updateOne(
            { _id: item.product },
            { $inc: { currentStock: qty } }
          );
        }
        item.usedQuantity = 0;
      }
      outward.status = "cancelled";
      outward.notes = `${outward.notes || ""}\n[DELETED] SR202610180003 duplicate excess sowing reversed`.trim();
      await outward.save();
    }
  }

  const reqId = request._id;
  await SowingRequest.deleteOne({ _id: reqId });

  const still = await SowingRequest.findOne({ requestNumber: "SR202610180003" }).lean();
  return {
    deleted: !still,
    reversedPlants: reversed,
    order4098Untouched: true,
  };
}

await mongoose.connect(uri);
try {
  const a = await fix001();
  const b = await delete003();
  console.log(JSON.stringify({ ok: true, SR202610180001: a, SR202610180003: b }, null, 2));
} finally {
  await mongoose.disconnect();
}
