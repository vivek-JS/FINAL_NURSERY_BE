import { excessFieldsForBatch, stampSlotDocument } from "./sowingBatchExcessStamp.js";

const TOUCH = /sowingBatches|plantsSowed|orderCoveredPlants|excessPlants|mortalityMovedToExcess|isIrrelevant/;

function updateTouchesSowExcess(update) {
  return TOUCH.test(JSON.stringify(update || {}));
}

async function bufferPctForPlant(plantId) {
  if (!plantId) return 0;
  const { default: PlantCms } = await import("../models/plantCms.model.js");
  const plant = await PlantCms.findById(plantId).select("sowingBuffer").lean();
  const n = Number(plant?.sowingBuffer);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function plantQtyByOrderId(doc) {
  const ids = [];
  for (const subtype of doc?.subtypeSlots || []) {
    for (const slot of subtype?.slots || []) {
      for (const batch of slot?.sowingBatches || []) {
        for (const id of batch?.linkedOrderIds || []) ids.push(id);
      }
    }
  }
  if (!ids.length) return new Map();
  try {
    const { default: Order } = await import("../models/order.model.js");
    const orders = await Order.find({ _id: { $in: ids } })
      .select("numberOfPlants additionalPlants")
      .lean();
    return new Map(
      orders.map((order) => [
        String(order._id),
        (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0),
      ])
    );
  } catch (err) {
    console.error("sowing order qty lookup failed", err?.message || err);
    return null;
  }
}

function excessSet(doc, pct, plantQtyByOrderId = null) {
  const $set = {};
  (doc?.subtypeSlots || []).forEach((subtype, subtypeIndex) => {
    (subtype?.slots || []).forEach((slot, slotIndex) => {
      (slot?.sowingBatches || []).forEach((batch, batchIndex) => {
        const fields = excessFieldsForBatch(batch, pct, plantQtyByOrderId);
        const base = `subtypeSlots.${subtypeIndex}.slots.${slotIndex}.sowingBatches.${batchIndex}`;
        $set[`${base}.sowingBufferPct`] = fields.sowingBufferPct;
        $set[`${base}.bufferPlants`] = fields.bufferPlants;
        $set[`${base}.shownExcess`] = fields.shownExcess;
      });
    });
  });
  return $set;
}

/** Writes the three excess numbers without going through document middleware again. */
export async function persistStampedExcess(model, doc) {
  if (!doc?._id) return;
  const pct = await bufferPctForPlant(doc.plantId);
  const qty = await plantQtyByOrderId(doc);
  const $set = excessSet(doc, pct, qty);
  if (!Object.keys($set).length) return;
  await model.collection.updateOne({ _id: doc._id }, { $set });
}

export function attachSowingExcessMiddleware(plantSlotSchema) {
  plantSlotSchema.pre("save", async function stampExcessBeforeSave() {
    const pct = await bufferPctForPlant(this.plantId);
    const qty = await plantQtyByOrderId(this);
    stampSlotDocument(this, pct, qty);
  });

  for (const op of ["updateOne", "findOneAndUpdate", "updateMany"]) {
    plantSlotSchema.post(op, async function restampExcessAfterUpdate() {
      if (!updateTouchesSowExcess(this.getUpdate())) return;
      try {
        const docs = await this.model
          .find(this.getQuery())
          .select("plantId subtypeSlots.slots.sowingBatches")
          .lean();
        for (const doc of docs) {
          await persistStampedExcess(this.model, doc);
        }
      } catch (err) {
        console.error("sowing excess stamp failed", err?.message || err);
      }
    });
  }
}
