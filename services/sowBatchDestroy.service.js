import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import AppError from "../utility/appError.js";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";

const toInt = (v) => Math.max(0, Math.floor(Number(v) || 0));
const idStr = (v) => (v == null || v === "" ? "" : String(v));

export const sowBatchLeft = (batch) =>
  Math.max(0, toInt(batch?.plantsSowed) - toInt(batch?.destroyedPlants));

/**
 * Pure plan: take `quantity` from the chosen batches (newest first) and work out what the slot loses.
 * Free stock (availablePlants) goes first; survivors (actualPlants) and sowed counts drop by the full amount.
 */
export function planSowBatchDestroy({ slot, batches, quantity }) {
  const qty = toInt(quantity);
  if (qty < 1) return { error: "Destroy quantity must be at least 1" };
  const left = batches.reduce((s, b) => s + sowBatchLeft(b), 0);
  if (qty > left) return { error: `Only ${left} plants left on this sowing batch` };

  const takes = [];
  let rest = qty;
  const ordered = [...batches].sort((a, b) => new Date(b.sowedAt || 0) - new Date(a.sowedAt || 0));
  for (const b of ordered) {
    if (rest <= 0) break;
    const take = Math.min(rest, sowBatchLeft(b));
    if (take > 0) takes.push({ batchId: idStr(b._id), plants: take });
    rest -= take;
  }

  const available = Number(slot?.availablePlants) || 0;
  return {
    quantity: qty,
    takes,
    primarySowed: Math.max(0, toInt(slot?.primarySowed) - qty),
    plantsSowed: Math.max(0, toInt(slot?.plantsSowed) - qty),
    actualPlants: Math.max(0, toInt(slot?.actualPlants) - qty),
    availablePlants: available > 0 ? Math.max(0, available - qty) : available,
    excessivePlants: Math.max(0, toInt(slot?.excessiveSowing?.plants) - Math.min(qty, Math.max(0, available))),
  };
}

/**
 * Destroy plants of a sowing batch on its ready slot (one batch by id, or all batches of a sowing request).
 * The batch keeps plantsSowed; destroyedPlants + destroyLog record the loss.
 */
export async function destroySowBatchPlants({
  slotId,
  batchId,
  sowingRequestId,
  quantity,
  reason,
  performedBy,
}) {
  if (!mongoose.isValidObjectId(String(slotId))) throw new AppError("Invalid slot id", 400);
  if (!batchId && !sowingRequestId) throw new AppError("Sowing batch is required", 400);
  const by = performedBy && mongoose.isValidObjectId(String(performedBy)) ? performedBy : undefined;
  const reasonStr = String(reason ?? "").trim().slice(0, 500);

  const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId });
  let slot = null;
  for (const st of plantSlot?.subtypeSlots || []) {
    slot = st.slots.id(slotId);
    if (slot) break;
  }
  if (!slot) throw new AppError("Slot not found", 404);

  const batches = (slot.sowingBatches || []).filter((b) =>
    batchId ? idStr(b._id) === idStr(batchId) : idStr(b.sowingRequestId) === idStr(sowingRequestId)
  );
  if (!batches.length) throw new AppError("Sowing batch not found on this slot", 404);

  const plan = planSowBatchDestroy({ slot, batches, quantity });
  if (plan.error) throw new AppError(plan.error, 400);

  const now = new Date();
  for (const t of plan.takes) {
    const b = slot.sowingBatches.id(t.batchId);
    b.destroyedPlants = toInt(b.destroyedPlants) + t.plants;
    b.destroyLog = [...(b.destroyLog || []), { at: now, by, plants: t.plants, reason: reasonStr }];
  }
  slot.primarySowed = plan.primarySowed;
  slot.plantsSowed = plan.plantsSowed;
  if (slot.excessiveSowing) slot.excessiveSowing.plants = plan.excessivePlants;
  const label = batches[0]?.requestNumber || "sowing batch";
  applyStockFieldUpdates(
    slot,
    { actualPlants: plan.actualPlants, availablePlants: plan.availablePlants },
    by,
    `Sowing destroyed · ${label} (−${plan.quantity})${reasonStr ? ` · ${reasonStr}` : ""}`
  );
  if (by) slot.setPerformer?.(by);
  await plantSlot.save({ validateBeforeSave: true });

  return {
    slotId: idStr(slotId),
    destroyed: plan.quantity,
    batches: plan.takes,
    primarySowed: slot.primarySowed,
    availablePlants: slot.availablePlants,
    left: batches.reduce((s, b) => s + sowBatchLeft(b), 0),
  };
}
