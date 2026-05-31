import { getSlotTrailActivityName } from "../constants/slotTrailActions.js";

const defaultReasonForTrail = (trail) => {
  const notes = typeof trail?.notes === "string" ? trail.notes.trim() : "";
  if (notes) return notes;
  const action = trail?.action;
  if (action) return getSlotTrailActivityName(action);
  return "Legacy trail entry";
};

/**
 * Backfill required slotTrail fields on in-memory PlantSlot documents before save/validate.
 * Legacy $push updates and older code paths omitted reason and/or activityName.
 */
export function normalizeSlotTrailInPlantSlot(plantSlotDoc) {
  if (!plantSlotDoc?.subtypeSlots?.length) return 0;

  let fixedCount = 0;

  for (const subtypeSlot of plantSlotDoc.subtypeSlots) {
    for (const slot of subtypeSlot.slots || []) {
      if (!slot?.slotTrail?.length) continue;

      for (const trail of slot.slotTrail) {
        if (!trail) continue;

        const activityName =
          typeof trail.activityName === "string" ? trail.activityName.trim() : "";
        if (!activityName || activityName === "undefined") {
          trail.activityName = getSlotTrailActivityName(trail.action);
          fixedCount++;
        }

        const reason = typeof trail.reason === "string" ? trail.reason.trim() : "";
        if (!reason) {
          trail.reason = defaultReasonForTrail(trail);
          fixedCount++;
        }
      }
    }
  }

  if (fixedCount > 0 && typeof plantSlotDoc.markModified === "function") {
    plantSlotDoc.markModified("subtypeSlots");
  }

  return fixedCount;
}
